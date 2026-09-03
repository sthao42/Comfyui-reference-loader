# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-09-02

### Added
- **Descriptive Aspect Ratio Presets**: User-friendly named presets for `LoadImageCrop` and `LoadVideoCrop`:
  - `None` (freeform / unconstrained)
  - `1:1 (Square)`
  - `2:3 (35mm Portrait)`
  - `3:2 (35mm Standard)`
  - `3:4 (Standard Portrait)`
  - `4:3 (Standard)`
  - `4:5 (Instagram Portrait)`
  - `5:4 (Photography)`
  - `9:16 (Widescreen Portrait)`
  - `16:9 (Widescreen)`
  - `16:10 (Display)`
  - `21:9 (Ultrawide)`
- **Dynamic Ratio Parsing**: Backend `parse_aspect_ratio()` and frontend `parseAspectRatio()` supporting labeled strings, custom ratios (e.g. `18:9 (Mobile)`), and legacy strings.
- **Packaging & Versioning**: Added `pyproject.toml` and package `__version__ = "1.1.0"`.

### Changed
- Default `aspect_ratio` set to `"None"`.
- Video preview monitor header cleanly suppresses aspect tag when set to `None`.

---

## [1.0.0] - 2026-08-30

### Added
- **Load Image & Crop**: Interactive canvas-drawn crop box with aspect ratio locking, megapixel downscaling, and VAE dimension alignment.
- **Load Video & Crop / Timeline**: Video loading with interactive crop monitor, filmstrip thumbnails, audio waveform visualizer, and playback trimming.
- **Load Audio & Crop**: Audio loading with waveform playback, draggable range pins, and timecode trimming.
- **Downscale Image to Megapixels**: Lightweight utility node for megapixel budget scaling.
- **Diffusion Model Quantization**: Frame rounding for Wan, Hunyuan, LTX, Cosmos, Mochi, and MiniMax H3 models.
- **Nodes 2.0 Compatibility**: Support for ComfyUI's Vue-based node interface.
