"""Load Video & Crop / Timeline node re-export for backwards compatibility."""

try:
    from .nodes.video_nodes import (
        ASPECT_RATIOS,
        DIVISIBLE_BY,
        FIT_MODES,
        QUANTIZE_MODES,
        LoadVideoCrop,
        _parse_crop,
        quantize_count,
    )
except (ImportError, ValueError):
    from nodes.video_nodes import (
        ASPECT_RATIOS,
        DIVISIBLE_BY,
        FIT_MODES,
        QUANTIZE_MODES,
        LoadVideoCrop,
        _parse_crop,
        quantize_count,
    )

__all__ = [
    "LoadVideoCrop",
    "ASPECT_RATIOS",
    "DIVISIBLE_BY",
    "FIT_MODES",
    "QUANTIZE_MODES",
    "_parse_crop",
    "quantize_count",
]
