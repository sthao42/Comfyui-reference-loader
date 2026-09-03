"""Video processing nodes: LoadVideoCrop with visual frame timeline, audio extraction, model quantization, and crop controls."""

import hashlib
import json
import math
import os
import re
from typing import Optional, Tuple

import folder_paths  # type: ignore[import-not-found]
import torch

# Model quantization presets
QUANTIZE_FREE = "free"
QUANTIZE_CUSTOM = "custom (multiple of N)"

QUANTIZE_PRESETS: dict[str, Tuple[int, int]] = {
    "Wan (4n+1)": (4, 1),
    "Hunyuan (4n+1)": (4, 1),
    "LTX (8n+1)": (8, 1),
    "Cosmos (8n+1)": (8, 1),
    "Mochi (6n+1)": (6, 1),
    "MiniMax H3 (17n+5)": (17, 5),
}

QUANTIZE_MODES = [QUANTIZE_FREE, *QUANTIZE_PRESETS.keys(), QUANTIZE_CUSTOM]
QUANTIZE_ROUND_UP = {"MiniMax H3 (17n+5)"}

# Hard cap on decoded video frames (frame_count=0 means "decode to end").
# ~11 days at 24fps — bounds memory for absurdly long inputs.
MAX_DECODE_FRAMES = 1_000_000


def quantize_grid(mode: str, k: int = 8) -> Optional[Tuple[int, int]]:
    """Return (step, offset) for a quantization mode, or None for free."""
    if mode == QUANTIZE_CUSTOM:
        try:
            return (max(1, int(k)), 0)
        except (TypeError, ValueError):
            return (1, 0)
    return QUANTIZE_PRESETS.get(mode)


def first_stop(step: int, offset: int) -> int:
    """Smallest valid count for model quantization."""
    return offset if offset > 1 else offset + step


def quantize_count(n: int, mode: str, k: int = 8) -> int:
    """Round a frame count to the nearest valid count for the chosen model."""
    try:
        n = max(0, int(n))
    except (TypeError, ValueError):
        n = 0
    grid = quantize_grid(mode, k)
    if grid is None or n == 0:
        return n
    step, offset = grid
    low = first_stop(step, offset)
    if n <= low:
        return low
    if mode in QUANTIZE_ROUND_UP:
        return offset + ((n - offset + step - 1) // step) * step
    return offset + ((n - offset) // step) * step


# Aspect ratio and sizing helpers
ASPECT_RATIOS = [
    "None",
    "1:1 (Square)",
    "2:3 (35mm Portrait)",
    "3:2 (35mm Standard)",
    "3:4 (Standard Portrait)",
    "4:3 (Standard)",
    "4:5 (Instagram Portrait)",
    "5:4 (Photography)",
    "9:16 (Widescreen Portrait)",
    "16:9 (Widescreen)",
    "16:10 (Display)",
    "21:9 (Ultrawide)",
]

ASPECT_RATIO_VALUES: dict[str, Optional[Tuple[int, int]]] = {
    "None": None,
    "none": None,
    "1:1 (Square)": (1, 1),
    "1:1": (1, 1),
    "2:3 (35mm Portrait)": (2, 3),
    "2:3": (2, 3),
    "3:2 (35mm Standard)": (3, 2),
    "3:2": (3, 2),
    "3:4 (Standard Portrait)": (3, 4),
    "3:4": (3, 4),
    "4:3 (Standard)": (4, 3),
    "4:3": (4, 3),
    "4:5 (Instagram Portrait)": (4, 5),
    "4:5": (4, 5),
    "5:4 (Photography)": (5, 4),
    "5:4": (5, 4),
    "9:16 (Widescreen Portrait)": (9, 16),
    "9:16": (9, 16),
    "16:9 (Widescreen)": (16, 9),
    "16:9": (16, 9),
    "16:10 (Display)": (16, 10),
    "16:10": (16, 10),
    "21:9 (Ultrawide)": (21, 9),
    "21:9": (21, 9),
    # Legacy presets
    "9:21": (9, 21),
    "10:16": (10, 16),
    "2:1": (2, 1),
    "1:2": (1, 2),
}


def parse_aspect_ratio(val: Optional[str]) -> Optional[Tuple[int, int]]:
    """Parse aspect ratio string into (w, h) tuple, or None for free/disabled."""
    if not val:
        return None
    val_str = str(val).strip()
    if val_str.lower() in ("none", "free", "disabled", "custom"):
        return None
    if val_str in ASPECT_RATIO_VALUES:
        return ASPECT_RATIO_VALUES[val_str]
    match = re.match(r"^(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)", val_str)
    if match:
        try:
            w = float(match.group(1))
            h = float(match.group(2))
            if w > 0 and h > 0:
                if w.is_integer() and h.is_integer():
                    return (int(w), int(h))
                return (round(w * 1000), round(h * 1000))
        except (ValueError, TypeError):
            return None
    return None

DIVISIBLE_BY = [
    "disabled",
    "8",
    "16",
    "32",
    "64",
]

FIT_MODES = [
    "contain",
    "cover",
    "stretch",
]


def _parse_crop(
    crop: str, width: int, height: int
) -> Optional[Tuple[int, int, int, int]]:
    """Return (x0, y0, x1, y1) pixel box, or None for full image."""
    if not crop or width <= 0 or height <= 0:
        return None
    try:
        data = json.loads(crop)
        x = float(data.get("x", 0))
        y = float(data.get("y", 0))
        w = float(data.get("w", data.get("width", 1)))
        h = float(data.get("h", data.get("height", 1)))
        if not all(math.isfinite(v) for v in (x, y, w, h)):
            return None
        if w <= 0 or h <= 0:
            return None
    except (ValueError, KeyError, TypeError):
        return None
    x0 = max(0, min(width - 1, round(x * width)))
    y0 = max(0, min(height - 1, round(y * height)))
    x1 = max(x0 + 1, min(width, round((x + w) * width)))
    y1 = max(y0 + 1, min(height, round((y + h) * height)))
    if x0 == 0 and y0 == 0 and x1 == width and y1 == height:
        return None
    return (x0, y0, x1, y1)


def _resize(chw: torch.Tensor, width: int, height: int) -> torch.Tensor:
    """Resize [N, C, H, W] tensor using antialiased interpolation."""
    import comfy.utils  # type: ignore[import-not-found]

    src_h, src_w = chw.shape[-2], chw.shape[-1]
    if width * 2 <= src_w and height * 2 <= src_h:
        return torch.nn.functional.interpolate(chw, size=(height, width), mode="area")
    if width * height < src_w * src_h:
        return torch.nn.functional.interpolate(
            chw,
            size=(height, width),
            mode="bicubic",
            antialias=True,
            align_corners=False,
        )
    return comfy.utils.common_upscale(chw, width, height, "lanczos", "disabled")


def fit_frames(
    t: torch.Tensor, width: int, height: int, mode: str
) -> Tuple[torch.Tensor, torch.Tensor]:
    """Fit [N, H, W, C] frames to target width and height using contain, cover, or stretch."""
    n, src_h, src_w, c = t.shape
    if src_h == height and src_w == width:
        return t, torch.zeros((n, height, width), dtype=torch.float32, device=t.device)

    chw = t.movedim(-1, 1)  # [N, C, H, W]
    mask = torch.zeros((n, height, width), dtype=torch.float32, device=t.device)

    if mode == "cover":
        try:
            keep_w = max(1, min(src_w, int(round(src_h * width / height))))
            keep_h = max(1, min(src_h, int(round(src_w * height / width))))
        except (TypeError, ValueError, ZeroDivisionError):
            keep_w, keep_h = width, height
        x, y = max(0, (src_w - keep_w) // 2), max(0, (src_h - keep_h) // 2)
        out = _resize(chw[:, :, y : y + keep_h, x : x + keep_w], width, height)
    elif mode == "stretch":
        out = _resize(chw, width, height)
    else:  # contain
        scale = min(width / max(1, src_w), height / max(1, src_h))
        try:
            inner_w = max(1, min(width, int(round(src_w * scale))))
            inner_h = max(1, min(height, int(round(src_h * scale))))
        except (TypeError, ValueError, ZeroDivisionError):
            inner_w, inner_h = width, height
        inner = _resize(chw, inner_w, inner_h)
        out = torch.zeros((n, c, height, width), dtype=chw.dtype, device=chw.device)
        y = max(0, (height - inner_h) // 2)
        x = max(0, (width - inner_w) // 2)
        out[:, :, y : y + inner_h, x : x + inner_w] = inner
        if inner_w < width or inner_h < height:
            mask = torch.ones((n, height, width), dtype=torch.float32, device=t.device)
            mask[:, y : y + inner_h, x : x + inner_w] = 0.0

    return out.movedim(1, -1).clamp(0.0, 1.0), mask.clamp(0.0, 1.0)


def _f32_pcm(wav: torch.Tensor) -> torch.Tensor:
    """Convert audio tensor to float 32-bit PCM (-1.0 to 1.0)."""
    if wav.dtype.is_floating_point:
        return wav.to(torch.float32)
    elif wav.dtype == torch.int16:
        return wav.float() / 32768.0
    elif wav.dtype == torch.int32:
        return wav.float() / 2147483648.0
    elif wav.dtype == torch.int8:
        return wav.float() / 128.0
    elif wav.dtype == torch.uint8:
        return (wav.float() - 128.0) / 128.0
    return wav.to(torch.float32)


# PyAV video and audio decoder
def _load_video_and_audio(
    filepath: str,
    start_frame: int = 0,
    frame_count: int = 0,
    target_fps: float = 0.0,
) -> Tuple[torch.Tensor, Optional[dict], float, int]:
    """Decode video frames and audio track using PyAV."""
    import av  # type: ignore[import-not-found]

    if not filepath or not os.path.isfile(filepath):
        raise FileNotFoundError(f"Video file not found: {filepath}")

    with av.open(filepath) as container:
        if not container.streams.video:
            raise ValueError(f"No video stream found in file: {filepath}")

        vstream = container.streams.video[0]
        try:
            src_fps = float(vstream.average_rate or vstream.r_frame_rate or 24.0)
        except (TypeError, ValueError):
            src_fps = 24.0
        if src_fps <= 0 or not math.isfinite(src_fps):
            src_fps = 24.0

        effective_fps = target_fps if target_fps > 0.0 else src_fps
        vstream.thread_type = "AUTO"

        # Seek close to start frame if needed
        seek_sec = max(0.0, (start_frame / src_fps) - 0.5)
        if seek_sec > 0.5 and vstream.time_base:
            try:
                seek_pts = int(seek_sec / float(vstream.time_base))
            except (TypeError, ValueError, ZeroDivisionError):
                seek_pts = 0
            try:
                container.seek(seek_pts, stream=vstream)
            except Exception:
                container.seek(0)

        raw_frames = []
        frame_idx = 0
        total_decoded = 0

        for frame in container.decode(vstream):
            try:
                pts_sec = (
                    float(frame.pts * vstream.time_base)
                    if frame.pts is not None and vstream.time_base
                    else total_decoded / src_fps
                )
                approx_src_idx = int(round(pts_sec * src_fps))
            except (TypeError, ValueError, ZeroDivisionError):
                pts_sec = total_decoded / src_fps
                approx_src_idx = total_decoded

            if approx_src_idx < start_frame and frame_idx < start_frame:
                frame_idx = max(frame_idx + 1, approx_src_idx)
                continue

            arr = frame.to_ndarray(format="rgb24")
            raw_frames.append(arr)
            frame_idx += 1
            total_decoded += 1

            if len(raw_frames) > MAX_DECODE_FRAMES:
                raise ValueError(
                    f"Video too long: more than {MAX_DECODE_FRAMES} frames decoded. "
                    "Set frame_count to bound the load."
                )

            if (
                frame_count > 0
                and len(raw_frames)
                >= frame_count * max(1.0, src_fps / effective_fps) + 10
            ):
                break

        if not raw_frames:
            container.seek(0)
            for frame in container.decode(vstream):
                raw_frames.append(frame.to_ndarray(format="rgb24"))
                if len(raw_frames) > MAX_DECODE_FRAMES:
                    raise ValueError(
                        f"Video too long: more than {MAX_DECODE_FRAMES} frames decoded. "
                        "Set frame_count to bound the load."
                    )
                if frame_count > 0 and len(raw_frames) >= start_frame + frame_count:
                    break
            raw_frames = raw_frames[start_frame:]

        if not raw_frames:
            raise ValueError(f"No frames could be decoded from video: {filepath}")

        # Resample frame rate if target FPS differs from source
        total_src = len(raw_frames)
        if target_fps > 0.0 and abs(target_fps - src_fps) > 0.01:
            try:
                req_count = (
                    frame_count
                    if frame_count > 0
                    else max(1, int(round(total_src * (target_fps / src_fps))))
                )
                req_count = max(1, req_count)
                picks = [
                    min(total_src - 1, max(0, int(round(i * (src_fps / target_fps)))))
                    for i in range(req_count)
                ]
            except (TypeError, ValueError, ZeroDivisionError):
                fallback = frame_count if frame_count > 0 else total_src
                picks = list(range(min(fallback, total_src)))
            selected = [raw_frames[i] for i in picks]
        else:
            selected = raw_frames[:frame_count] if frame_count > 0 else raw_frames

        if not selected:
            selected = [raw_frames[0]]

        # Convert selected frames to torch float32 tensor efficiently without redundant copies
        num_frames = len(selected)
        sample_frame = selected[0]
        fh, fw, fc = sample_frame.shape
        frames_tensor = torch.empty((num_frames, fh, fw, fc), dtype=torch.float32)
        for idx in range(num_frames):
            frames_tensor[idx] = (
                torch.from_numpy(selected[idx]).to(dtype=torch.float32).div_(255.0)
            )
            selected[idx] = None
        del raw_frames
        del selected

        # Extract and slice synchronized audio track
        audio_dict = None
        if container.streams.audio:
            try:
                astream = container.streams.audio[0]
                sr = astream.codec_context.sample_rate or 44100
                n_channels = astream.channels or 1

                start_sec = start_frame / src_fps
                duration_sec = num_frames / effective_fps
                seek_audio_sec = max(0.0, start_sec - 1.0)

                if astream.time_base and seek_audio_sec > 0.5:
                    pts = int(seek_audio_sec / float(astream.time_base))
                    try:
                        container.seek(pts, stream=astream)
                    except Exception:
                        container.seek(0)
                else:
                    container.seek(0)

                aframes = []
                decoded_audio_sec = seek_audio_sec
                end_needed_sec = start_sec + duration_sec + 1.0

                for aframe in container.decode(astream):
                    cur_sec = (
                        float(aframe.pts * astream.time_base)
                        if aframe.pts is not None and astream.time_base
                        else decoded_audio_sec
                    )
                    buf = torch.from_numpy(aframe.to_ndarray())
                    if getattr(aframe.format, "is_planar", False):
                        if buf.dim() == 1:
                            buf = buf.unsqueeze(0)
                    else:
                        if n_channels > 1:
                            buf = buf.reshape(-1, n_channels).t()
                        elif buf.dim() == 1:
                            buf = buf.unsqueeze(0)
                    aframes.append((cur_sec, buf))
                    decoded_audio_sec = cur_sec + (buf.shape[-1] / sr)

                    if cur_sec > end_needed_sec:
                        break

                if not aframes:
                    container.seek(0)
                    for aframe in container.decode(astream):
                        buf = torch.from_numpy(aframe.to_ndarray())
                        if getattr(aframe.format, "is_planar", False):
                            if buf.dim() == 1:
                                buf = buf.unsqueeze(0)
                        else:
                            if n_channels > 1:
                                buf = buf.reshape(-1, n_channels).t()
                            elif buf.dim() == 1:
                                buf = buf.unsqueeze(0)
                        aframes.append((0.0, buf))
                        if len(aframes) * (buf.shape[-1] / sr) > end_needed_sec + 2.0:
                            break

                if aframes:
                    aframes.sort(key=lambda x: x[0])
                    first_pts_sec = aframes[0][0]
                    cat_wav = torch.cat([x[1] for x in aframes], dim=1)
                    cat_wav = _f32_pcm(cat_wav)
                    if cat_wav.dim() == 1:
                        cat_wav = cat_wav.unsqueeze(0).unsqueeze(0)
                    elif cat_wav.dim() == 2:
                        cat_wav = cat_wav.unsqueeze(0)

                    rel_start_sec = max(0.0, start_sec - first_pts_sec)
                    start_samp = int(round(rel_start_sec * sr))
                    end_samp = min(
                        cat_wav.shape[-1],
                        int(round((rel_start_sec + duration_sec) * sr)),
                    )

                    if start_samp < cat_wav.shape[-1]:
                        trimmed_wav = cat_wav[:, :, start_samp:end_samp].contiguous()
                    else:
                        expected_len = max(1, int(round(duration_sec * sr)))
                        trimmed_wav = torch.zeros(
                            (1, cat_wav.shape[1], expected_len), dtype=torch.float32
                        )

                    audio_dict = {
                        "waveform": trimmed_wav,
                        "sample_rate": int(sr),
                    }
            except Exception as e:
                print(f"[reference_loader] Failed to decode audio from video: {e}")

        return frames_tensor, audio_dict, effective_fps, total_src


# LoadVideoCrop Node
class LoadVideoCrop:
    CATEGORY = "reference_loader/video"
    FUNCTION = "load"
    RETURN_TYPES = (
        "IMAGE",
        "AUDIO",
        "MASK",
        "INT",
        "INT",
        "FLOAT",
        "INT",
        "FLOAT",
        "INT",
        "IMAGE",
        "STRING",
    )
    RETURN_NAMES = (
        "images",
        "audio",
        "mask",
        "width",
        "height",
        "fps",
        "frame_count",
        "duration",
        "current_frame",
        "current_image",
        "markers",
    )
    DESCRIPTION = (
        "Loads a video and audio with a visual filmstrip timeline, live preview monitor, "
        "crop controls, trim handles, diffusion model frame quantization, and markers."
    )

    OUTPUT_TOOLTIPS = (
        "Video frame batch [N, H, W, 3], cropped and quantized.",
        "Synchronized audio track trimmed to match the video range.",
        "Mask (1.0 for letterbox padding, 0.0 for video content).",
        "Output width in pixels.",
        "Output height in pixels.",
        "Effective frame rate (FPS).",
        "Number of output frames.",
        "Total duration in seconds.",
        "Current playhead frame index.",
        "Single frame [1, H, W, 3] under the playhead.",
        "Comma-separated marker frame indices relative to output batch.",
    )

    @classmethod
    def _list_video_files(cls, input_dir: str) -> list[str]:
        """List video files in input directory."""
        if not os.path.exists(input_dir):
            return []
        try:
            files = [
                f
                for f in os.listdir(input_dir)
                if os.path.isfile(os.path.join(input_dir, f))
            ]
        except OSError:
            files = []
        filter_fn = getattr(folder_paths, "filter_files_content_types", None)
        if filter_fn is not None:
            try:
                return filter_fn(files, ["video", "image"])
            except Exception:
                pass
        VIDEO_EXTS = (".mp4", ".mov", ".mkv", ".webm", ".avi", ".gif", ".webp", ".m4v")
        return [f for f in files if f.lower().endswith(VIDEO_EXTS)]

    @classmethod
    def INPUT_TYPES(cls):
        try:
            input_dir = folder_paths.get_input_directory()
            os.makedirs(input_dir, exist_ok=True)
            files = sorted(cls._list_video_files(input_dir))
        except Exception:
            files = []

        return {
            "required": {
                "video": (
                    files,
                    {
                        "video_upload": True,
                        "tooltip": "The video file to load. Upload, drag & drop, or pick an existing file.",
                    },
                ),
                "start_frame": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 1000000,
                        "step": 1,
                        "tooltip": "Trim start frame (0 = start of video).",
                    },
                ),
                "frame_count": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 1000000,
                        "step": 1,
                        "tooltip": "Number of frames to load (0 = load to end).",
                    },
                ),
                "fps": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 240.0,
                        "step": 0.01,
                        "tooltip": "Target frame rate (0 = keep native FPS).",
                    },
                ),
                "model_quantize": (
                    QUANTIZE_MODES,
                    {
                        "default": QUANTIZE_FREE,
                        "tooltip": "Snap frame count to diffusion model requirements (Wan, Hunyuan, LTX, Cosmos, Mochi, MiniMax H3).",
                    },
                ),
                "quantize_n": (
                    "INT",
                    {
                        "default": 8,
                        "min": 1,
                        "max": 256,
                        "step": 1,
                        "tooltip": "Custom multiple when 'custom (multiple of N)' is selected.",
                    },
                ),
                "aspect_ratio": (
                    ASPECT_RATIOS,
                    {
                        "default": "None",
                        "tooltip": "Lock crop selection or output to standard aspect ratios (16:9, 9:16, 1:1, etc.).",
                    },
                ),
                "max_megapixels": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 128.0,
                        "step": 0.01,
                        "tooltip": "Downscale frames if total pixels exceed this megapixel limit (0 = disable).",
                    },
                ),
                "divisible_by": (
                    DIVISIBLE_BY,
                    {
                        "default": "disabled",
                        "tooltip": "Snap output dimensions to multiples of 8, 16, 32, or 64 for model compatibility.",
                    },
                ),
                "fit": (
                    FIT_MODES,
                    {
                        "default": "contain",
                        "tooltip": "Fitting mode when aspect ratio changes: contain (pad), cover (crop), stretch.",
                    },
                ),
                "crop": (
                    "STRING",
                    {
                        "default": "",
                        "tooltip": "Crop box JSON managed interactively by the preview monitor.",
                    },
                ),
                "markers": (
                    "STRING",
                    {
                        "default": "",
                        "tooltip": "Marker frame indices managed interactively on the timeline (press M to mark).",
                    },
                ),
                "playhead": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 1000000,
                        "step": 1,
                        "tooltip": "Current playhead frame position.",
                    },
                ),
            },
        }

    def load(
        self,
        video: str,
        start_frame: int = 0,
        frame_count: int = 0,
        fps: float = 0.0,
        model_quantize: str = QUANTIZE_FREE,
        quantize_n: int = 8,
        aspect_ratio: str = "None",
        max_megapixels: float = 0.0,
        divisible_by: str = "disabled",
        fit: str = "contain",
        crop: str = "",
        markers: str = "",
        playhead: int = 0,
        **kwargs,
    ):
        if not video or video == "none":
            raise ValueError("LoadVideoCrop: No video file selected.")

        video_path = folder_paths.get_annotated_filepath(video)
        try:
            start_f = max(0, int(start_frame))
            req_count = max(0, int(frame_count))
        except (TypeError, ValueError):
            start_f, req_count = 0, 0

        if req_count > 0:
            req_count = quantize_count(req_count, model_quantize, quantize_n)

        # Decode video frames and audio
        try:
            target_fps = float(fps)
        except (TypeError, ValueError):
            target_fps = 24.0
        frames, audio, effective_fps, total_src = _load_video_and_audio(
            video_path,
            start_frame=start_f,
            frame_count=req_count,
            target_fps=target_fps,
        )

        # Quantize decoded frames if frame_count was 0 (auto)
        try:
            count = int(frames.shape[0])
        except (TypeError, ValueError):
            count = 0
        if req_count <= 0 and model_quantize != QUANTIZE_FREE:
            quantized_total = quantize_count(count, model_quantize, quantize_n)
            if quantized_total < count:
                frames = frames[:quantized_total]
                count = quantized_total
                if audio is not None and "waveform" in audio:
                    sr = audio["sample_rate"]
                    try:
                        max_s = int(round((count / effective_fps) * sr))
                    except (TypeError, ValueError, ZeroDivisionError):
                        max_s = audio["waveform"].shape[-1]
                    audio["waveform"] = audio["waveform"][:, :, :max_s].contiguous()

        if count <= 0:
            raise ValueError("LoadVideoCrop: No frames could be extracted.")

        # Interactive spatial crop
        box = _parse_crop(crop, frames.shape[2], frames.shape[1])
        if box is not None:
            x0, y0, x1, y1 = box
            frames = frames[:, y0:y1, x0:x1, :]

        # Aspect ratio and resolution sizing
        height, width = frames.shape[1], frames.shape[2]
        new_width, new_height = width, height

        ar_tuple = parse_aspect_ratio(aspect_ratio)
        if ar_tuple is not None:
            w_part, h_part = ar_tuple
            target_aspect = w_part / h_part
            current_aspect = width / height
            if abs(current_aspect - target_aspect) > 0.005:
                try:
                    if fit == "cover":
                        if current_aspect > target_aspect:
                            crop_w = int(round(height * target_aspect))
                            cx = (width - crop_w) // 2
                            frames = frames[:, :, cx : cx + crop_w, :]
                        else:
                            crop_h = int(round(width / target_aspect))
                            cy = (height - crop_h) // 2
                            frames = frames[:, cy : cy + crop_h, :, :]
                        height, width = frames.shape[1], frames.shape[2]
                        new_width, new_height = width, height
                    elif fit == "contain":
                        if current_aspect > target_aspect:
                            new_height = int(round(width / target_aspect))
                        else:
                            new_width = int(round(height * target_aspect))
                    elif fit == "stretch":
                        if current_aspect > target_aspect:
                            new_width = int(round(height * target_aspect))
                        else:
                            new_height = int(round(width / target_aspect))
                except (TypeError, ValueError, ZeroDivisionError):
                    pass

        # Megapixel limit
        if max_megapixels > 0.0:
            target_pixels = max_megapixels * 1024 * 1024
            curr_pixels = new_width * new_height
            if curr_pixels > target_pixels:
                scale = (target_pixels / curr_pixels) ** 0.5
                new_width = max(1, round(new_width * scale))
                new_height = max(1, round(new_height * scale))

        # Divisible_by alignment (minimum multiple of 2 for video codec compatibility)
        div = 2
        if divisible_by != "disabled":
            try:
                user_div = int(divisible_by)
                if user_div > 1:
                    div = user_div
            except (ValueError, TypeError):
                div = 2

        new_width = max(div, round(new_width / div) * div)
        new_height = max(div, round(new_height / div) * div)

        if new_width != frames.shape[2] or new_height != frames.shape[1]:
            frames, mask = fit_frames(frames, new_width, new_height, fit)
        else:
            mask = torch.zeros(
                (frames.shape[0], frames.shape[1], frames.shape[2]), dtype=torch.float32
            )

        try:
            out_w = int(frames.shape[2])
            out_h = int(frames.shape[1])
            out_count = int(frames.shape[0])
            duration = float(out_count / effective_fps) if effective_fps > 0 else 0.0
            cur_idx = max(0, min(out_count - 1, int(playhead)))
        except (TypeError, ValueError, ZeroDivisionError):
            out_w, out_h, out_count, duration, cur_idx = (
                frames.shape[2],
                frames.shape[1],
                frames.shape[0],
                0.0,
                0,
            )
        current_image = frames[cur_idx : cur_idx + 1].clone()

        # Parse freeze markers
        parsed_markers = []
        if markers:
            for m in re.findall(r"-?\d+", str(markers)):
                try:
                    idx = int(m)
                    if idx < 0:
                        idx = out_count + idx
                    if 0 <= idx < out_count and idx not in parsed_markers:
                        parsed_markers.append(idx)
                except ValueError:
                    pass
        parsed_markers.sort()
        markers_str = ", ".join(str(m) for m in parsed_markers)

        # Silent audio fallback if source video had no audio track
        if audio is None:
            try:
                silent_samples = max(1, int(round(duration * 44100)))
            except (TypeError, ValueError, OverflowError):
                silent_samples = 44100
            audio = {
                "waveform": torch.zeros((1, 2, silent_samples), dtype=torch.float32),
                "sample_rate": 44100,
            }

        try:
            out_fps = float(effective_fps)
        except (TypeError, ValueError):
            out_fps = 0.0

        return (
            frames,
            audio,
            mask,
            out_w,
            out_h,
            out_fps,
            out_count,
            duration,
            cur_idx,
            current_image,
            markers_str,
        )

    @classmethod
    def IS_CHANGED(
        cls,
        video: str,
        start_frame: int = 0,
        frame_count: int = 0,
        fps: float = 0.0,
        model_quantize: str = QUANTIZE_FREE,
        quantize_n: int = 8,
        aspect_ratio: str = "None",
        max_megapixels: float = 0.0,
        divisible_by: str = "disabled",
        fit: str = "contain",
        crop: str = "",
        markers: str = "",
        playhead: int = 0,
        **kwargs,
    ) -> str:
        if not video:
            return ""
        try:
            video_path = folder_paths.get_annotated_filepath(video)
            if not os.path.isfile(video_path):
                return ""
            m = hashlib.sha256()
            with open(video_path, "rb") as f:
                f.seek(0, os.SEEK_END)
                size = f.tell()
                m.update(str(size).encode("utf-8"))
                f.seek(0)
                m.update(f.read(65536))
                if size > 65536:
                    f.seek(max(0, size - 65536))
                    m.update(f.read(65536))
            m.update(
                f"{start_frame}:{frame_count}:{fps:.3f}:{model_quantize}:{quantize_n}".encode()
            )
            m.update(
                f"{aspect_ratio}:{max_megapixels}:{divisible_by}:{fit}:{crop}:{markers}:{playhead}".encode()
            )
            return m.digest().hex()
        except Exception:
            return f"{video}:{start_frame}:{frame_count}:{fps}:{model_quantize}:{crop}:{playhead}"

    @classmethod
    def VALIDATE_INPUTS(
        cls,
        video: str,
        start_frame: int = 0,
        frame_count: int = 0,
        fps: float = 0.0,
        model_quantize: str = QUANTIZE_FREE,
        quantize_n: int = 8,
        aspect_ratio: str = "None",
        max_megapixels: float = 0.0,
        divisible_by: str = "disabled",
        fit: str = "contain",
        crop: str = "",
        markers: str = "",
        playhead: int = 0,
        **kwargs,
    ):
        if not video or not isinstance(video, str):
            return "No video file selected"
        if not folder_paths.exists_annotated_filepath(video):
            return f"Invalid video file: {video}"
        return True
