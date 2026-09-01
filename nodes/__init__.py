"""Reference Loader node class mappings and display names registry."""

from .audio_nodes import (
    LoadAudioCrop,
)
from .image_nodes import (
    DownscaleImageToMegapixels,
    LoadImageCrop,
)
from .video_nodes import (
    LoadVideoCrop,
)

NODE_CLASS_MAPPINGS = {
    "LoadImageCrop": LoadImageCrop,
    "DownscaleImageToMegapixels": DownscaleImageToMegapixels,
    "LoadAudioCrop": LoadAudioCrop,
    "LoadVideoCrop": LoadVideoCrop,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LoadImageCrop": "Load Image & Crop",
    "DownscaleImageToMegapixels": "Downscale Image to Megapixels",
    "LoadAudioCrop": "Load Audio & Crop",
    "LoadVideoCrop": "Load Video & Crop / Timeline",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
