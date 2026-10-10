# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.5] - 2026-10-10

### Fixed
- **Initial Node Sizing & Layout Fit**: Resolved an issue where `LoadVideoCrop`, `LoadAudioCrop`, and `LoadImageCrop` loaded onto the canvas undersized, causing bottom transport toolbars, waveform tracks, or image previews to overflow until the user manually clicked or resized the nodes.
- **Custom Widget `computeSize`**: Implemented `computeSize(width)` across all custom canvas widgets (`video_timeline_ui`, `audio_seeker_player`, `crop_editor`) to calculate required component heights for LiteGraph rather than defaulting to nominal widget heights.
- **Node-Level Dimension Clamping**: Wrapped `node.computeSize`, configured `node.min_size`, implemented `node.onResize`, and added `nodeCreated` extension hooks and `onConfigure` size validation to enforce minimum bounds across node creation, workflow restoration, and resizing.
- **Image Preview Auto-Fit Tuning**: Adjusted default height and eliminated duplicate preview offset calculations in `LoadImageCrop` to prevent oversized cards and excessive blank spacing below image previews on initial load.

---

## [1.1.4] - 2026-10-05

### Changed
- **Click-to-Open Context Windows**: The `?` helper icon on all nodes (`LoadImageCrop`, `LoadVideoCrop`, `LoadAudioCrop`) now requires an explicit click to toggle the guide popup instead of popping open on mouse hover. Hovering over `?` displays an accent highlight and pointer cursor without opening the floating context window.
- **Context Window Dismissal**: Floating guide context windows can now be closed by clicking the `?` icon again, clicking the new close `✕` button in the popup header, clicking anywhere outside the popup, or pressing `Escape`.

### Fixed
- **Nodes 2.0 (Vue Mode) Support**: Implemented a responsive DOM mirror for the `?` helper badge and context window popup in ComfyUI Nodes 2.0 (Vue nodes mode), resolving an issue where the canvas-drawn title bar badge was omitted by ComfyUI's Vue renderer.

---

## [1.1.3] - 2026-09-04

### Fixed
- **Audio Waveform Loading on Workflow Reload**: Fixed a critical race condition in `LoadAudioCrop` where consecutive load calls during graph initialization and workflow configuration caused in-flight audio decoding to be aborted and permanently frozen in `"Loading audio waveform..."`.
- **Audio State Machine & Lifecycle**: Decoupled in-flight loading URL from active loaded buffer, added `onGraphConfigured` lifecycle hook, draw-loop self-healing, Web Audio context closed-state recovery, and click-to-retry on error.
- **Crop Times Clamping During Load**: Prevented collapsing start and end crop times to 0 when duration is initially 0 while audio is loading.
- **Backend Argument Normalization**: Added defensive handling in `LoadAudioCrop` (`load`, `IS_CHANGED`, `VALIDATE_INPUTS`) for audio arguments passed as dictionary objects.

---

## [1.1.1] - 2026-09-04

### Fixed
- **Double Image Preview**: Suppressed duplicate preview rendering in `LoadImageCrop` by intercepting preview widget injections, preventing `node.imgs` assignment races, and purging stock preview widgets across all lifecycle events.
- **ReferenceError TDZ Bug**: Pre-declared `editorWidget` in `LoadImageCrop` to prevent `ReferenceError: Cannot access 'editorWidget' before initialization` during graph loading and configure.
- **Non-Configurable Widget Values**: Prevented `TypeError: Cannot redefine property: value` across `LoadImageCrop`, `LoadVideoCrop`, and `LoadAudioCrop` when running in modern ComfyUI frontends (Node 2.0 Vue mode).
- **Dual-Mode Value Sync**: Added render-loop value synchronization across both Classic LiteGraph canvas and Node 2.0 Vue views for direct external widget value modifications.
- **Context Menu Actions**: Added "Open Image", "Copy Image", "Save Image", and "Open in MaskEditor | Image Canvas" options to `LoadImageCrop`.

---

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
