"""Image processing nodes: interactive LoadImageCrop and Megapixel Downscaling."""

import hashlib
import json
import math
import os

import numpy as np
import torch
from PIL import Image, ImageOps, ImageSequence

import folder_paths
import node_helpers


def _parse_crop(crop, width, height):
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


ASPECT_RATIOS = [
    "none",
    "1:1",
    "16:9",
    "9:16",
    "4:3",
    "3:4",
    "3:2",
    "2:3",
    "4:5",
    "5:4",
    "21:9",
    "9:21",
    "16:10",
    "10:16",
    "2:1",
    "1:2",
]

DIVISIBLE_BY = [
    "disabled",
    "8",
    "16",
    "32",
    "64",
]


class LoadImageCrop:
    CATEGORY = "reference_loader/image"
    FUNCTION = "load"
    RETURN_TYPES = ("IMAGE", "MASK", "INT", "INT")
    RETURN_NAMES = ("image", "mask", "width", "height")
    DESCRIPTION = (
        "Loads an image with interactive visual crop editing on the node preview. "
        "Supports aspect ratio locking, megapixel downscaling, and dimension alignment."
    )

    OUTPUT_TOOLTIPS = (
        "The loaded image, cropped to selection and scaled if options are set.",
        "Alpha channel mask, cropped and scaled to match the image.",
        "Output image width in pixels.",
        "Output image height in pixels.",
    )

    @classmethod
    def INPUT_TYPES(cls):
        input_dir = folder_paths.get_input_directory()
        files = [f for f in os.listdir(input_dir) if os.path.isfile(os.path.join(input_dir, f))]
        files = folder_paths.filter_files_content_types(files, ["image"])
        return {
            "required": {
                "image": (sorted(files), {
                    "image_upload": True,
                    "tooltip": "The image file to load. Upload, drag & drop, or pick an existing input file.",
                }),
                "crop": ("STRING", {
                    "default": "",
                    "tooltip": "Managed by the crop editor on the node — no need to edit by hand.",
                }),
                "aspect_ratio": (ASPECT_RATIOS, {
                    "default": "none",
                    "tooltip": "Lock crop selection to a fixed aspect ratio (e.g. 16:9, 9:16, 1:1), or 'none' for freeform.",
                }),
                "max_megapixels": ("FLOAT", {
                    "default": 0.0, "min": 0.0, "max": 128.0, "step": 0.01,
                    "tooltip": "If the selected image area is larger than this many megapixels, then it is downscaled to it for output. Set to 0 to disable downscaling.",
                }),
                "divisible_by": (DIVISIBLE_BY, {
                    "default": "disabled",
                    "tooltip": "Snap output dimensions to multiples of 8, 16, 32, or 64 for VAE and model compatibility.",
                }),
            }
        }

    def load(self, image, crop="", aspect_ratio="none", max_megapixels=0.0, divisible_by="disabled", **kwargs):
        if not image or image == "none":
            raise ValueError("LoadImageCrop: No image file selected.")
        image_path = folder_paths.get_annotated_filepath(image)
        img = node_helpers.pillow(Image.open, image_path)

        output_images = []
        output_masks = []
        w, h = None, None

        for i in ImageSequence.Iterator(img):
            i = node_helpers.pillow(ImageOps.exif_transpose, i)

            frame = i.convert("RGB")
            if len(output_images) == 0:
                w, h = frame.size
            if frame.size != (w, h):
                continue

            # Guard against excessively large images (500 MP hard limit).
            if w * h > 500 * 1024 * 1024:
                raise ValueError(
                    f"Image too large ({w}x{h}). Maximum supported size is 500 megapixels."
                )

            frame = np.array(frame).astype(np.float32) / 255.0
            frame = torch.from_numpy(frame)[None,]
            if "A" in i.getbands():
                mask = np.array(i.getchannel("A")).astype(np.float32) / 255.0
                mask = 1.0 - torch.from_numpy(mask)
            elif i.mode == "P" and "transparency" in i.info:
                rgba = i.convert("RGBA")
                mask = np.array(rgba.getchannel("A")).astype(np.float32) / 255.0
                mask = 1.0 - torch.from_numpy(mask)
            else:
                mask = torch.zeros((h, w), dtype=torch.float32)
            output_images.append(frame)
            output_masks.append(mask.unsqueeze(0))

        if not output_images:
            raise ValueError(f"No valid image frames found in: {image_path}")

        images = torch.cat(output_images, dim=0)
        masks = torch.cat(output_masks, dim=0)

        box = _parse_crop(crop, images.shape[2], images.shape[1])
        if box is not None:
            x0, y0, x1, y1 = box
            images = images[:, y0:y1, x0:x1, :]
            masks = masks[:, y0:y1, x0:x1]

        height, width = images.shape[1], images.shape[2]
        new_width, new_height = width, height

        if max_megapixels > 0:
            target = max_megapixels * 1024 * 1024
            current = width * height
            if current > target:
                scale = (target / current) ** 0.5
                new_width = max(1, round(width * scale))
                new_height = max(1, round(height * scale))

        if divisible_by != "disabled":
            try:
                div = int(divisible_by)
                if div > 1:
                    new_width = max(div, round(new_width / div) * div)
                    new_height = max(div, round(new_height / div) * div)
            except (ValueError, TypeError):
                pass

        if new_width != width or new_height != height:
            import comfy.utils

            images = comfy.utils.common_upscale(
                images.movedim(-1, 1), new_width, new_height, "lanczos", "disabled"
            ).movedim(1, -1)
            masks = comfy.utils.common_upscale(
                masks.unsqueeze(1), new_width, new_height, "bilinear", "disabled"
            ).squeeze(1)

        images = images.clamp(0.0, 1.0)
        masks = masks.clamp(0.0, 1.0)

        out_w = int(images.shape[2])
        out_h = int(images.shape[1])
        return (images, masks, out_w, out_h)

    @classmethod
    def IS_CHANGED(cls, image, crop="", aspect_ratio="none", max_megapixels=0.0, divisible_by="disabled", **kwargs):
        if not image:
            return ""
        try:
            image_path = folder_paths.get_annotated_filepath(image)
            if not os.path.isfile(image_path):
                return ""
            m = hashlib.sha256()
            with open(image_path, "rb") as f:
                f.seek(0, os.SEEK_END)
                size = f.tell()
                m.update(str(size).encode("utf-8"))
                f.seek(0)
                m.update(f.read(65536))
                if size > 65536:
                    f.seek(max(0, size - 65536))
                    m.update(f.read(65536))
            m.update(crop.encode("utf-8"))
            m.update(str(aspect_ratio).encode("utf-8"))
            m.update(str(max_megapixels).encode("utf-8"))
            m.update(str(divisible_by).encode("utf-8"))
            return m.digest().hex()
        except Exception:
            return f"{image}:{crop}:{aspect_ratio}:{max_megapixels}:{divisible_by}"

    @classmethod
    def VALIDATE_INPUTS(cls, image, crop="", aspect_ratio="none", max_megapixels=0.0, divisible_by="disabled", **kwargs):
        if not image or not isinstance(image, str):
            return "No image file selected"
        if not folder_paths.exists_annotated_filepath(image):
            return f"Invalid image file: {image}"
        return True


class DownscaleImageToMegapixels:
    CATEGORY = "reference_loader/image"
    FUNCTION = "downscale"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    DESCRIPTION = (
        "Scales an image down to fit within a target megapixel budget while preserving aspect ratio. "
        "Images already under the target pass through untouched."
    )

    OUTPUT_TOOLTIPS = (
        "The image scaled down to the target megapixel budget (or None if unconnected).",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "megapixels": ("FLOAT", {
                    "default": 1.0, "min": 0.01, "max": 128.0, "step": 0.01,
                    "tooltip": "Maximum output size in megapixels (1.0 = 1024x1024 pixels). Larger images are scaled down to fit; smaller ones pass through untouched.",
                }),
                "method": (["lanczos", "area", "bicubic", "bilinear", "nearest-exact"], {
                    "default": "lanczos",
                    "tooltip": "Resampling filter used when downscaling.",
                }),
            },
            "optional": {
                "image": ("IMAGE", {
                    "tooltip": "The image to downscale. Leave unconnected to output None (bypass).",
                }),
            },
        }

    def downscale(self, megapixels, method, image=None):
        if image is None:
            return (None,)
        if not isinstance(image, torch.Tensor):
            return (image,)
        if image.dim() == 3:
            image = image.unsqueeze(0)
        elif image.dim() != 4 or image.shape[0] == 0:
            return (image,)

        import comfy.utils

        height, width = image.shape[1], image.shape[2]
        if width <= 0 or height <= 0:
            return (image,)
        target = megapixels * 1024 * 1024
        current = width * height
        if current <= target:
            return (image,)
        scale = (target / current) ** 0.5
        new_width = max(1, round(width * scale))
        new_height = max(1, round(height * scale))
        samples = image.movedim(-1, 1)
        samples = comfy.utils.common_upscale(samples, new_width, new_height, method, "disabled")
        return (samples.movedim(1, -1).clamp(0.0, 1.0),)
