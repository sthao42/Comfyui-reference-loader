"""Load Audio & Crop node re-export for convenience."""

try:
    from .nodes.audio_nodes import (
        LoadAudioCrop,
        _load_audio_file,
    )
except (ImportError, ValueError):
    from nodes.audio_nodes import (
        LoadAudioCrop,
        _load_audio_file,
    )

__all__ = ["LoadAudioCrop", "_load_audio_file"]
