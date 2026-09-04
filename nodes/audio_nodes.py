"""Audio processing nodes: LoadAudioCrop with interactive waveform seeker, player, and timeline cropping."""

import hashlib
import math
import os
import wave

import folder_paths
import numpy as np
import torch


def _f32_pcm(wav: torch.Tensor) -> torch.Tensor:
    """Convert audio tensor to float 32-bit PCM format (-1.0 to 1.0)."""
    if wav.dtype.is_floating_point:
        return wav.to(torch.float32)
    if wav.dtype == torch.int16:
        return wav.float() / 32768.0
    if wav.dtype == torch.int32:
        return wav.float() / 2147483648.0
    if wav.dtype == torch.int8:
        return wav.float() / 128.0
    if wav.dtype == torch.uint8:
        return (wav.float() - 128.0) / 128.0
    return wav.to(torch.float32)


def _load_audio_file(filepath, start_sec: float = 0.0, end_sec: float = 0.0):
    """Load an audio file (or a [start_sec, end_sec] window) into a torch tensor
    [1, channels, samples] and sample_rate.

    When start_sec/end_sec are given the PyAV path seeks and stops decoding near
    the window, so memory is bounded by the crop instead of the full track.
    """
    if not filepath or not os.path.isfile(filepath):
        raise FileNotFoundError(f"Audio file not found: {filepath}")

    # Try PyAV first (handles most codecs/containers)
    try:
        import av

        with av.open(filepath) as container:
            if container.streams.audio:
                stream = container.streams.audio[0]
                sr = stream.codec_context.sample_rate or 44100
                n_channels = stream.channels or 1

                # Seek a little before the window start (keyframes land early).
                if start_sec > 0.5:
                    try:
                        container.seek(int(max(0.0, start_sec - 0.5) * 1_000_000))
                    except Exception:
                        container.seek(0)

                frames = []
                first_pts_sec = None
                for frame in container.decode(stream):
                    pts_sec = (
                        float(frame.pts * stream.time_base)
                        if frame.pts is not None and stream.time_base
                        else None
                    )
                    if start_sec > 0.0:
                        if pts_sec is None:
                            # No timestamps: windowing is unreliable, fall back
                            # to a full decode in one of the backends below.
                            break
                        if pts_sec < start_sec - 0.1:
                            continue
                        if end_sec > 0.0 and pts_sec > end_sec + 0.1:
                            break
                    if first_pts_sec is None:
                        first_pts_sec = pts_sec
                    buf = torch.from_numpy(frame.to_ndarray())
                    if getattr(frame.format, "is_planar", False):
                        if buf.dim() == 1:
                            buf = buf.unsqueeze(0)
                    else:
                        if n_channels > 1:
                            buf = buf.reshape(-1, n_channels).t()
                        elif buf.dim() == 1:
                            buf = buf.unsqueeze(0)
                    frames.append(buf)
                if frames:
                    wav = torch.cat(frames, dim=1)
                    wav = _f32_pcm(wav)
                    if wav.dim() == 1:
                        wav = wav.unsqueeze(0).unsqueeze(0)
                    elif wav.dim() == 2:
                        wav = wav.unsqueeze(0)
                    # Trim to the exact window using the first frame's PTS.
                    if start_sec > 0.0 and first_pts_sec is not None:
                        lead = max(0.0, start_sec - first_pts_sec)
                        drop = int(round(lead * sr))
                        if drop > 0:
                            wav = wav[:, :, drop:]
                        if end_sec > 0.0:
                            keep = max(0, int(round((end_sec - first_pts_sec) * sr)))
                            wav = wav[:, :, :keep]
                    return wav, int(sr)
    except Exception:
        pass

    # Try soundfile
    try:
        import soundfile as sf

        with sf.SoundFile(filepath) as sf_file:
            data = sf_file.read(dtype="float32", always_2d=True)
            sample_rate = sf_file.samplerate
            waveform = (
                torch.from_numpy(np.ascontiguousarray(data.T))
                .unsqueeze(0)
                .to(torch.float32)
            )
            return waveform, int(sample_rate)
    except Exception:
        pass

    # Try torchaudio
    try:
        import torchaudio

        waveform, sample_rate = torchaudio.load(filepath)
        if waveform.dim() == 1:
            waveform = waveform.unsqueeze(0).unsqueeze(0)
        elif waveform.dim() == 2:
            waveform = waveform.unsqueeze(0)
        return waveform.to(torch.float32), int(sample_rate)
    except Exception:
        pass

    # Fallback to standard library wave for basic WAV files
    try:
        with wave.open(filepath, "rb") as wf:
            channels = wf.getnchannels()
            sample_width = wf.getsampwidth()
            sample_rate = wf.getframerate()
            num_frames = wf.getnframes()
            raw_data = wf.readframes(num_frames)

            if sample_width == 1:
                arr = (
                    np.frombuffer(raw_data, dtype=np.uint8).astype(np.float32) - 128.0
                ) / 128.0
            elif sample_width == 2:
                arr = (
                    np.frombuffer(raw_data, dtype=np.int16).astype(np.float32) / 32768.0
                )
            elif sample_width == 3:
                raw_bytes = np.frombuffer(raw_data, dtype=np.uint8)
                n_samples = len(raw_bytes) // 3
                raw_24 = raw_bytes[: n_samples * 3].reshape(-1, 3)
                int_32 = (
                    raw_24[:, 0].astype(np.int32)
                    | (raw_24[:, 1].astype(np.int32) << 8)
                    | (raw_24[:, 2].astype(np.int32) << 16)
                )
                negative = (int_32 & 0x800000) != 0
                int_32[negative] |= ~0xFFFFFF
                arr = int_32.astype(np.float32) / 8388608.0
            elif sample_width == 4:
                try:
                    arr = np.frombuffer(raw_data, dtype=np.float32)
                except Exception:
                    arr = (
                        np.frombuffer(raw_data, dtype=np.int32).astype(np.float32)
                        / 2147483648.0
                    )
            else:
                raise ValueError(f"Unsupported sample width: {sample_width} bytes")

            arr = np.ascontiguousarray(arr.reshape(-1, channels).T)
            waveform = torch.from_numpy(arr).unsqueeze(0).to(torch.float32)
            return waveform, int(sample_rate)
    except Exception as e:
        raise RuntimeError(
            f"Failed to load audio file '{os.path.basename(filepath)}'. Error: {e}"
        ) from e


class LoadAudioCrop:
    CATEGORY = "reference_loader/audio"
    FUNCTION = "load"
    RETURN_TYPES = ("AUDIO", "FLOAT")
    RETURN_NAMES = ("audio", "duration")
    DESCRIPTION = (
        "Loads an audio file with an interactive waveform player and timeline crop handles. "
        "Outputs the cropped audio and duration in seconds (or full track if uncropped)."
    )

    OUTPUT_TOOLTIPS = (
        "The loaded audio, cropped to the selected time range (or full audio if uncropped).",
        "Duration of the output audio rounded up to the nearest second.",
    )

    @classmethod
    def _list_audio_files(cls, input_dir):
        """List audio and video files in the input directory."""
        files = [
            f
            for f in os.listdir(input_dir)
            if os.path.isfile(os.path.join(input_dir, f))
        ]

        filter_fn = getattr(folder_paths, "filter_files_content_types", None)
        if filter_fn is not None:
            try:
                return filter_fn(files, ["audio", "video"])
            except Exception as e:
                print(
                    f"[reference_loader] filter_files_content_types failed, falling back: {e}"
                )

        AUDIO_VIDEO_EXTS = (
            ".wav",
            ".mp3",
            ".flac",
            ".ogg",
            ".m4a",
            ".aac",
            ".opus",
            ".wma",
            ".mp4",
            ".mov",
            ".mkv",
            ".webm",
            ".avi",
        )
        return [f for f in files if f.lower().endswith(AUDIO_VIDEO_EXTS)]

    @classmethod
    def INPUT_TYPES(cls):
        try:
            input_dir = folder_paths.get_input_directory()
            os.makedirs(input_dir, exist_ok=True)
            files = sorted(cls._list_audio_files(input_dir))
        except Exception as e:
            print(
                f"[reference_loader] LoadAudioCrop.INPUT_TYPES failed to list input files: {e}"
            )
            files = []

        return {
            "required": {
                "audio": (
                    files,
                    {
                        "audio_upload": True,
                        "tooltip": "The audio file to load. Upload, drag & drop, or select an existing file.",
                    },
                ),
                "start_time": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 100000.0,
                        "step": 1.0,
                        "tooltip": "Crop start time in seconds (0 = start). Snaps to nearest second.",
                    },
                ),
                "end_time": (
                    "FLOAT",
                    {
                        "default": 0.0,
                        "min": 0.0,
                        "max": 100000.0,
                        "step": 1.0,
                        "tooltip": "Crop end time in seconds (0 = full track / end). Snaps to nearest second.",
                    },
                ),
            },
            "optional": {
                # ComfyUI AUDIOUPLOAD widget expects a companion "audioUI" widget.
                # Kept under optional since it's a non-serializing DOM element.
                "audioUI": ("AUDIO_UI", {}),
            },
        }

    @staticmethod
    def _normalize_audio_arg(audio):
        """Extract a valid file string if audio was passed as a dict."""
        if isinstance(audio, dict):
            fn = audio.get("filename") or audio.get("name") or ""
            sub = audio.get("subfolder") or ""
            t = audio.get("type") or "input"
            if sub:
                fn = f"{sub}/{fn}"
            if t and t != "input":
                fn = f"{fn} [{t}]"
            return fn
        return audio

    @staticmethod
    def _to_seconds(value, default=0.0):
        """Coerce a widget value to a non-negative finite float (defensive)."""
        try:
            secs = float(value)
        except (TypeError, ValueError):
            return default
        if not math.isfinite(secs):
            return default
        return secs

    def load(self, audio, start_time=0.0, end_time=0.0, **kwargs):
        audio = self._normalize_audio_arg(audio)
        if not audio or audio == "none":
            raise ValueError("LoadAudioCrop: No audio file selected.")
        audio_path = folder_paths.get_annotated_filepath(audio)

        start_req = max(0.0, self._to_seconds(start_time))
        end_req = self._to_seconds(end_time)
        is_explicit_crop = (start_req > 0.001) or (
            end_req > 0.001 and end_req > start_req
        )

        # Decode only the requested window (memory is bounded by the crop, not the
        # full track). When no crop is requested the whole track is decoded, as before.
        waveform, sample_rate = _load_audio_file(
            audio_path,
            start_sec=start_req if is_explicit_crop else 0.0,
            end_sec=(end_req if end_req > 0.0 else 0.0) if is_explicit_crop else 0.0,
        )

        window_start = start_req if is_explicit_crop else 0.0
        total_samples = waveform.shape[-1]
        window_end = window_start + (
            total_samples / sample_rate if sample_rate > 0 else 0.0
        )

        start_t = max(0.0, min(window_end, start_req))
        end_t = (
            min(window_end, end_req)
            if (end_req > 0.0 and end_req > start_t)
            else window_end
        )

        is_full_track = not is_explicit_crop and start_t <= 0.001

        if is_full_track:
            out_waveform = waveform
            out_duration = window_end - window_start
        else:
            try:
                start_sample = max(
                    0,
                    min(
                        total_samples,
                        int(round((start_t - window_start) * sample_rate)),
                    ),
                )
                end_sample = (
                    max(
                        start_sample + 1,
                        min(
                            total_samples,
                            int(round((end_t - window_start) * sample_rate)),
                        ),
                    )
                    if total_samples > 0
                    else 0
                )
            except (TypeError, ValueError, ZeroDivisionError):
                start_sample, end_sample = 0, 0
            if total_samples > 0 and start_sample < total_samples:
                out_waveform = waveform[:, :, start_sample:end_sample].contiguous()
                out_duration = (
                    (out_waveform.shape[-1] / sample_rate) if sample_rate > 0 else 0.0
                )
            else:
                out_waveform = torch.zeros(
                    (1, waveform.shape[1], 1), dtype=torch.float32
                )
                out_duration = 0.0

        audio_dict = {
            "waveform": out_waveform,
            "sample_rate": sample_rate,
        }

        # Round output duration up to the nearest whole second
        duration_ceil = math.ceil(round(out_duration, 4))

        return (audio_dict, duration_ceil)

    @classmethod
    def IS_CHANGED(cls, audio, start_time=0.0, end_time=0.0, **kwargs):
        audio = cls._normalize_audio_arg(audio)
        if not audio:
            return ""
        try:
            audio_path = folder_paths.get_annotated_filepath(audio)
            if not os.path.isfile(audio_path):
                return ""
            m = hashlib.sha256()
            with open(audio_path, "rb") as f:
                f.seek(0, os.SEEK_END)
                size = f.tell()
                m.update(str(size).encode("utf-8"))
                f.seek(0)
                m.update(f.read(65536))
                if size > 65536:
                    f.seek(max(0, size - 65536))
                    m.update(f.read(65536))
            m.update(f"{start_time:.4f}:{end_time:.4f}".encode())
            return m.digest().hex()
        except Exception:
            return f"{audio}:{start_time}:{end_time}"

    @classmethod
    def VALIDATE_INPUTS(cls, audio, start_time=0.0, end_time=0.0, **kwargs):
        audio = cls._normalize_audio_arg(audio)
        if not audio:
            return "No audio file selected"
        if not isinstance(audio, str) or not folder_paths.exists_annotated_filepath(
            audio
        ):
            return f"Invalid audio file: {audio}"
        return True
