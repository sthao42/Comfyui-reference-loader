import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const MARGIN = 10;
const RULER_H = 22;
const FILMSTRIP_H = 44;
const WAVEFORM_H = 36;
const HANDLE_RADIUS = 8;
const CROP_HANDLE_SIZE = 6;
const MIN_SEL_PX = 10;
const RESIZE_CORNER_SIZE = 20;
const MIN_NODE_WIDTH = 480;
const MIN_NODE_HEIGHT = 650;
const CUSTOM_WIDGET_MIN_H = 350;

// Cap on file size fetched for the audio waveform preview (decodeAudioData on a
// huge video would allocate a multi-GB AudioBuffer and could OOM the tab).
const WAVEFORM_MAX_FILE_BYTES = 250 * 1024 * 1024;

// Quantization presets for diffusion models
const QUANTIZE_PRESETS = {
    "Wan (4n+1)": { step: 4, offset: 1 },
    "Hunyuan (4n+1)": { step: 4, offset: 1 },
    "LTX (8n+1)": { step: 8, offset: 1 },
    "Cosmos (8n+1)": { step: 8, offset: 1 },
    "Mochi (6n+1)": { step: 6, offset: 1 },
    "MiniMax H3 (17n+5)": { step: 17, offset: 5 },
};

const ASPECT_MAP = {
    "1:1 (Square)": 1.0,
    "1:1": 1.0,
    "2:3 (35mm Portrait)": 2 / 3,
    "2:3": 2 / 3,
    "3:2 (35mm Standard)": 3 / 2,
    "3:2": 3 / 2,
    "3:4 (Standard Portrait)": 3 / 4,
    "3:4": 3 / 4,
    "4:3 (Standard)": 4 / 3,
    "4:3": 4 / 3,
    "4:5 (Instagram Portrait)": 4 / 5,
    "4:5": 4 / 5,
    "5:4 (Photography)": 5 / 4,
    "5:4": 5 / 4,
    "9:16 (Widescreen Portrait)": 9 / 16,
    "9:16": 9 / 16,
    "16:9 (Widescreen)": 16 / 9,
    "16:9": 16 / 9,
    "16:10 (Display)": 16 / 10,
    "16:10": 16 / 10,
    "21:9 (Ultrawide)": 21 / 9,
    "21:9": 21 / 9,
    // Legacy presets
    "9:21": 9 / 21,
    "10:16": 10 / 16,
    "2:1": 2.0,
    "1:2": 0.5,
};

function parseAspectRatio(val) {
    if (!val || String(val).toLowerCase() === "none" || val === "free") return null;
    if (ASPECT_MAP[val] !== undefined) return ASPECT_MAP[val];
    const match = String(val).match(
        /^(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)/,
    );
    if (match) {
        const w = parseFloat(match[1]);
        const h = parseFloat(match[2]);
        if (w > 0 && h > 0 && Number.isFinite(w) && Number.isFinite(h)) return w / h;
    }
    return null;
}

const C = {
    bg: "#15181e",
    panelBg: "#1a1d24",
    border: "#333842",
    accent: "#4ab4ff",
    accentGlow: "rgba(74, 180, 255, 0.35)",
    text: "#dbe2ef",
    textDim: "#828d9f",
    playhead: "#ff5252",
    inOutShade: "rgba(0, 0, 0, 0.65)",
    inOutHandle: "#4ab4ff",
    marker: "#52e58f",
    markerText: "#10331e",
    cropShade: "rgba(0, 0, 0, 0.55)",
    cropBorder: "#4ab4ff",
    cropHandle: "#ffffff",
    quantizeTick: "rgba(74, 180, 255, 0.5)",
    waveBody: "rgba(74, 180, 255, 0.75)",
    wavePeak: "rgba(165, 225, 255, 0.95)",
    btnBg: "#252932",
    btnHover: "#353b47",
    btnActive: "#4ab4ff",
};

function isNodeCorner(px, py, node, margin = RESIZE_CORNER_SIZE) {
    if (!node?.size || !Array.isArray(node.size)) return false;
    const [w, h] = node.size;
    if (typeof w !== "number" || typeof h !== "number") return false;
    if (px >= w - margin && py >= h - margin) return true;
    if (px <= margin && py >= h - margin) return true;
    if (px >= w - margin && py <= margin) return true;
    if (px <= margin && py <= margin) return true;
    return false;
}

// Security: validate values used to build /view?filename=...&type=...&subfolder=...
// Older ComfyUI cores lack /view traversal guards, so a crafted workflow could
// escape the base directory. Reject traversal/absolute paths before hitting the
// server, and clamp type to directories /view knows about.
const VALID_VIEW_TYPES = ["input", "output", "temp"];

function isSafeViewPath(value) {
    if (typeof value !== "string") return false;
    if (value.length === 0) return true; // subfolder may be empty
    if (value.startsWith("/") || value.startsWith("\\")) return false;
    if (/^[A-Za-z]:/.test(value)) return false; // Windows drive letter
    return value
        .replace(/\\/g, "/")
        .split("/")
        .every((seg) => seg !== ".." && seg !== ".");
}

function clampViewType(value) {
    return VALID_VIEW_TYPES.includes(value) ? value : "input";
}

function parseVideoValue(value) {
    if (!value) return null;
    if (Array.isArray(value) && value.length > 0) {
        value = value[0];
    }
    if (typeof value === "object") {
        const fn =
            value.filename || value.name || (value.file && value.file.name);
        if (fn) {
            return {
                filename: fn,
                type: value.type || "input",
                subfolder: value.subfolder || "",
            };
        }
    }
    let filename = String(value);
    if (
        !filename ||
        filename === "[object Object]" ||
        filename === "undefined" ||
        filename === "null"
    ) {
        return null;
    }
    let type = "input";
    const annotated = filename.match(/^(.*) \[(\w+)\]$/);
    if (annotated) {
        filename = annotated[1];
        type = annotated[2];
    }
    filename = filename.replace(/\\/g, "/");
    let subfolder = "";
    const slash = filename.lastIndexOf("/");
    if (slash >= 0) {
        subfolder = filename.slice(0, slash);
        filename = filename.slice(slash + 1);
    }
    return { filename, type, subfolder };
}

function formatTimecode(seconds, fps = 24.0) {
    if (
        typeof seconds !== "number" ||
        !Number.isFinite(seconds) ||
        seconds < 0
    ) {
        return "00:00.00";
    }
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    const wholeSecs = Math.floor(secs);
    const frames = Math.floor((secs - wholeSecs) * fps);
    const mm = mins < 10 ? `0${mins}` : `${mins}`;
    const ss = wholeSecs < 10 ? `0${wholeSecs}` : `${wholeSecs}`;
    const ff = frames < 10 ? `0${frames}` : `${frames}`;
    return `${mm}:${ss}.${ff}`;
}

function drawRoundRect(ctx, x, y, w, h, r = 0) {
    if (w <= 0 || h <= 0) return;
    const radius = Math.max(
        0,
        Math.min(typeof r === "number" ? r : 0, w / 2, h / 2),
    );
    if (typeof ctx.roundRect === "function") {
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, radius);
    } else {
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.lineTo(x + w - radius, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
        ctx.lineTo(x + w, y + h - radius);
        ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
        ctx.lineTo(x + radius, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
        ctx.lineTo(x, y + radius);
        ctx.quadraticCurveTo(x, y, x + radius, y);
        ctx.closePath();
    }
}

let sharedAudioCtx = null;
function getAudioContext() {
    if (!sharedAudioCtx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) sharedAudioCtx = new AudioCtx();
    }
    if (sharedAudioCtx && sharedAudioCtx.state === "suspended") {
        sharedAudioCtx.resume().catch(() => {});
    }
    return sharedAudioCtx;
}

app.registerExtension({
    name: "reference_loader.load_video_crop",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "LoadVideoCrop") return;

        if (typeof LiteGraph === "undefined" || !LiteGraph.vueNodesMode) {
            nodeType.prototype.previewMediaType = "custom";
        }
        nodeType.prototype.onDrawBackground = function (_ctx) {};

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            const node = this;
            node.resizable = true;

            const isVueMode = () =>
                typeof LiteGraph !== "undefined" && !!LiteGraph.vueNodesMode;

            // Suppress default background preview canvas from drawing over/behind our custom editor
            node.onDrawBackground = function (_ctx) {
                if (
                    node.widgets?.some(
                        (w) =>
                            w.name === "video-preview" ||
                            w.element?.querySelector?.("video"),
                    )
                ) {
                    cleanStockPreviewWidgets();
                }
                if (videoWidget && videoWidget.value !== lastVideoVal) {
                    lastVideoVal = videoWidget.value;
                    loadVideo(lastVideoVal);
                }
            };
            // Assign properties but prevent Vue mode from forcing Media Card layout
            if (!isVueMode()) {
                node.previewMediaType = "custom";
            }

            node.imageIndex = 0;
            node.hideOutputImages = true;
            node.hideOutputVideos = true;
            node.animatedImages = false;

            // Intercept addDOMWidget to immediately reject and destroy any stock video player DOM widget
            const origAddDOMWidget = node.addDOMWidget;
            node.addDOMWidget = function (name, type, element, options) {
                const n = String(name || "").toLowerCase();
                const isVideoPreview =
                    n === "video-preview" ||
                    n === "videoui" ||
                    n.includes("preview") ||
                    type === "video" ||
                    (element &&
                        (element.tagName === "VIDEO" ||
                            element.querySelector?.("video")));
                if (isVideoPreview) {
                    if (element) {
                        element.remove?.();
                    }
                    return null;
                }
                return origAddDOMWidget?.apply(this, arguments);
            };

            const videoWidget = node.widgets?.find((w) => w.name === "video");
            const startFrameWidget = node.widgets?.find(
                (w) => w.name === "start_frame",
            );
            const frameCountWidget = node.widgets?.find(
                (w) => w.name === "frame_count",
            );
            const fpsWidget = node.widgets?.find((w) => w.name === "fps");
            const quantizeWidget = node.widgets?.find(
                (w) => w.name === "model_quantize",
            );
            const aspectWidget = node.widgets?.find(
                (w) => w.name === "aspect_ratio",
            );
            const cropWidget = node.widgets?.find((w) => w.name === "crop");
            const markersWidget = node.widgets?.find(
                (w) => w.name === "markers",
            );
            const playheadWidget = node.widgets?.find(
                (w) => w.name === "playhead",
            );

            // Function to suppress and remove any stock or core preview widgets (DOM video players, preview canvas)
            function cleanStockPreviewWidgets() {
                if (node.videoContainer) {
                    node.videoContainer.remove?.();
                    node.videoContainer = null;
                }
                if (node.widgets) {
                    for (let i = node.widgets.length - 1; i >= 0; i--) {
                        const w = node.widgets[i];
                        if (!w) continue;
                        const name = (w.name || "").toLowerCase();
                        if (
                            name === "video" ||
                            name === "start_frame" ||
                            name === "frame_count" ||
                            name === "fps" ||
                            name === "model_quantize" ||
                            name === "quantize_n" ||
                            name === "aspect_ratio" ||
                            name === "max_megapixels" ||
                            name === "divisible_by" ||
                            name === "fit" ||
                            name === "crop" ||
                            name === "markers" ||
                            name === "playhead" ||
                            name.includes("upload") ||
                            w.type === "button"
                        ) {
                            continue; // Keep actual inputs and upload button intact
                        }
                        const isStockPreview =
                            name === "video-preview" ||
                            name.includes("preview") ||
                            name === "videoui" ||
                            name === "audioui" ||
                            name === "$$canvas-video-preview" ||
                            name === "$$canvas-image-preview" ||
                            name === "$$comfy_animation_preview" ||
                            w.type === "video" ||
                            w.element?.tagName === "VIDEO" ||
                            w.element?.querySelector?.("video");

                        if (isStockPreview) {
                            if (w.element) {
                                w.element.remove?.();
                            }
                            w.onRemove?.();
                            node.widgets.splice(i, 1);
                        }
                    }
                }
                node.imgs = null;
                node.video = null;
                node.images = null;
                node.preview = null;
            }

            // Hide raw JSON / internal state widgets from default widget stack and collapse row heights
            [cropWidget, markersWidget, playheadWidget].forEach((w) => {
                if (w) {
                    w.hidden = true;
                    w.options = w.options || {};
                    w.options.hidden = true;
                    w.computeSize = () => [0, -4];
                }
            });

            cleanStockPreviewWidgets();

            // Internal Editor State
            const state = {
                videoEl: document.createElement("video"),
                videoLoaded: false,
                duration: 0.0,
                fps: 24.0,
                totalFrames: 0,
                videoWidth: 0,
                videoHeight: 0,
                currentFrame: 0,
                playheadTime: 0.0,
                isPlaying: false,
                isLooping: true,
                playbackRate: 1.0,

                // Timeline View State
                zoom: 1.0,
                scroll: 0.0,

                // Thumbnails
                thumbnails: [],
                isGeneratingThumbs: false,
                thumbSeq: 0,
                loadSeq: 0,
                lastLoadedUrl: null,

                // Waveform
                audioBuffer: null,
                waveformPeaks: null,

                // Crop & In/Out
                cropRect: null, // { x, y, w, h } in normalized 0..1 coordinates
                markers: new Set(),

                // Layout Boxes
                monitorBox: null, // { bx, by, bw, bh } for video viewport
                timelineBounds: null,

                isMuted: false,
                volume: 1.0,

                // Interaction
                dragTarget: null, // 'playhead' | 'inPoint' | 'outPoint' | 'crop'
                cropDrag: null, // { mode: 'new' | 'move' | 'resize', corner, startX, startY, moved, ... }
                hoverBtn: null,
                transportBtns: [],
                helpHovered: false,
                helpBadgeHovered: false,
                helpOpen: false,
                closeHovered: false,
            };

            // Restore saved crop from widget
            try {
                const saved = cropWidget?.value
                    ? JSON.parse(cropWidget.value)
                    : null;
                if (saved && (saved.w > 0 || saved.width > 0)) {
                    state.cropRect = {
                        x: saved.x || 0,
                        y: saved.y || 0,
                        w: saved.w || saved.width || 1,
                        h: saved.h || saved.height || 1,
                    };
                }
            } catch {
                state.cropRect = null;
            }

            state.videoEl.preload = "auto";
            state.videoEl.crossOrigin = "anonymous";
            state.videoEl.playsInline = true;
            state.videoEl.muted = false;
            state.videoEl.volume = 1.0;

            // Helper to sync crop to hidden widget
            function syncCrop() {
                if (!cropWidget) return;
                let value = "";
                if (
                    state.cropRect &&
                    state.cropRect.w > 0.001 &&
                    state.cropRect.h > 0.001
                ) {
                    const r = state.cropRect;
                    if (
                        !(
                            r.x < 0.002 &&
                            r.y < 0.002 &&
                            r.w > 0.996 &&
                            r.h > 0.996
                        )
                    ) {
                        value = JSON.stringify({
                            x: +r.x.toFixed(4),
                            y: +r.y.toFixed(4),
                            w: +r.w.toFixed(4),
                            h: +r.h.toFixed(4),
                        });
                    }
                }
                if (cropWidget.value !== value) {
                    cropWidget.value = value;
                    node.setDirtyCanvas(true, true);
                }
            }

            function getTargetAspectRatio() {
                const w = node.widgets?.find((x) => x.name === "aspect_ratio");
                return parseAspectRatio(w ? w.value : null);
            }

            function cropDims() {
                const vw = state.videoWidth || 1;
                const vh = state.videoHeight || 1;
                if (!state.cropRect) return [vw, vh];
                const r = state.cropRect;
                const x0 = Math.max(0, Math.min(vw - 1, Math.round(r.x * vw)));
                const y0 = Math.max(0, Math.min(vh - 1, Math.round(r.y * vh)));
                const x1 = Math.max(
                    x0 + 1,
                    Math.min(vw, Math.round((r.x + r.w) * vw)),
                );
                const y1 = Math.max(
                    y0 + 1,
                    Math.min(vh, Math.round((r.y + r.h) * vh)),
                );
                return [x1 - x0, y1 - y0];
            }

            function cappedDims(w, h) {
                let targetW = w;
                let targetH = h;
                const mpWidget = node.widgets?.find(
                    (x) => x.name === "max_megapixels",
                );
                const mp = mpWidget ? Number(mpWidget.value) || 0 : 0;
                if (mp > 0) {
                    const target = mp * 1024 * 1024;
                    if (targetW * targetH > target) {
                        const s = Math.sqrt(target / (targetW * targetH));
                        targetW = Math.max(1, Math.round(targetW * s));
                        targetH = Math.max(1, Math.round(targetH * s));
                    }
                }
                const divWidget = node.widgets?.find(
                    (x) => x.name === "divisible_by",
                );
                const divVal = divWidget ? divWidget.value : "disabled";
                let div = 2;
                if (divVal && divVal !== "disabled") {
                    const parsedDiv = parseInt(divVal, 10);
                    if (parsedDiv > 1) div = parsedDiv;
                }
                targetW = Math.max(div, Math.round(targetW / div) * div);
                targetH = Math.max(div, Math.round(targetH / div) * div);

                if (targetW === w && targetH === h) return null;
                return [targetW, targetH];
            }

            function applyAspectRatioConstraint() {
                const targetRatio = getTargetAspectRatio();
                if (!targetRatio || !state.cropRect || !state.videoLoaded)
                    return;

                const vw = state.videoWidth || 1;
                const vh = state.videoHeight || 1;
                const r = state.cropRect;

                const pw = r.w * vw;
                const ph = r.h * vh;
                if (pw <= 0 || ph <= 0) return;

                const cx = r.x + r.w / 2;
                const cy = r.y + r.h / 2;

                const currRatio = pw / ph;
                let newPw = pw;
                let newPh = ph;

                if (currRatio > targetRatio) {
                    newPw = ph * targetRatio;
                } else {
                    newPh = pw / targetRatio;
                }

                if (newPw > vw) {
                    newPw = vw;
                    newPh = vw / targetRatio;
                }
                if (newPh > vh) {
                    newPh = vh;
                    newPw = vh * targetRatio;
                }

                const newW = newPw / vw;
                const newH = newPh / vh;

                const newX = Math.max(0, Math.min(1 - newW, cx - newW / 2));
                const newY = Math.max(0, Math.min(1 - newH, cy - newH / 2));

                state.cropRect = {
                    x: newX,
                    y: newY,
                    w: newW,
                    h: newH,
                };
                syncCrop();
            }

            // Sync aspect ratio change
            if (aspectWidget) {
                const origAspectCb = aspectWidget.callback;
                aspectWidget.callback = function () {
                    applyAspectRatioConstraint();
                    origAspectCb?.apply(this, arguments);
                };
            }

            function hitTestCrop(px, py) {
                if (!state.cropRect || !state.monitorBox)
                    return { mode: "new" };
                const handle = CROP_HANDLE_SIZE + 3;
                const { bx, by, bw, bh } = state.monitorBox;
                const sx = bx + state.cropRect.x * bw;
                const sy = by + state.cropRect.y * bh;
                const sw = state.cropRect.w * bw;
                const sh = state.cropRect.h * bh;

                const handles = {
                    nw: [sx, sy],
                    ne: [sx + sw, sy],
                    sw: [sx, sy + sh],
                    se: [sx + sw, sy + sh],
                    n: [sx + sw / 2, sy],
                    s: [sx + sw / 2, sy + sh],
                    w: [sx, sy + sh / 2],
                    e: [sx + sw, sy + sh / 2],
                };

                for (const [name, [cx, cy]] of Object.entries(handles)) {
                    if (
                        Math.abs(px - cx) <= handle &&
                        Math.abs(py - cy) <= handle
                    ) {
                        return { mode: "resize", corner: name };
                    }
                }
                if (px >= sx && px <= sx + sw && py >= sy && py <= sy + sh) {
                    return { mode: "move", offX: px - sx, offY: py - sy };
                }
                return { mode: "new" };
            }

            // Helper to get video URL
            function getVideoUrl(val) {
                const parsed = parseVideoValue(val);
                if (!parsed || !parsed.filename) return null;
                parsed.type = clampViewType(parsed.type);
                if (
                    !isSafeViewPath(parsed.filename) ||
                    !isSafeViewPath(parsed.subfolder)
                ) {
                    console.error(
                        "[reference-loader] unsafe /view path, skipping:",
                        parsed.filename,
                        parsed.subfolder,
                    );
                    return null;
                }
                const q = new URLSearchParams({
                    filename: parsed.filename,
                    type: parsed.type || "input",
                    subfolder: parsed.subfolder || "",
                });
                if (typeof api !== "undefined" && api.apiURL) {
                    try {
                        return api.apiURL(`/view?${q}`);
                    } catch {}
                }
                return `/view?${q}`;
            }

            function onVideoMetadataReady() {
                if (
                    !state.videoEl.duration ||
                    !Number.isFinite(state.videoEl.duration)
                )
                    return;
                state.duration = state.videoEl.duration || 1.0;
                state.videoWidth = state.videoEl.videoWidth || 512;
                state.videoHeight = state.videoEl.videoHeight || 512;

                const wFps = Number(fpsWidget?.value);
                state.fps = wFps > 0 ? wFps : 24.0;
                state.totalFrames = Math.max(
                    1,
                    Math.round(state.duration * state.fps),
                );
                state.videoLoaded = true;

                if (
                    aspectWidget?.value &&
                    String(aspectWidget.value).toLowerCase() !== "none"
                ) {
                    applyAspectRatioConstraint();
                }

                generateThumbnails();
                node.setDirtyCanvas(true, true);
            }

            state.videoEl.addEventListener(
                "loadedmetadata",
                onVideoMetadataReady,
            );
            state.videoEl.addEventListener("loadeddata", onVideoMetadataReady);
            state.videoEl.addEventListener("canplay", () => {
                if (!state.videoLoaded) onVideoMetadataReady();
            });
            state.videoEl.addEventListener("error", (e) => {
                console.error(
                    "[reference-loader] video element failed to load src:",
                    state.videoEl.src,
                    e,
                );
                state.videoLoaded = false;
                node.setDirtyCanvas(true, true);
            });

            // Load and initialize video
            function loadVideo(val, forceRefresh = false) {
                const url = getVideoUrl(val);
                if (!url) {
                    state.videoLoaded = false;
                    state.thumbnails = [];
                    state.waveformPeaks = null;
                    state.lastLoadedUrl = null;
                    state.thumbSeq++;
                    state.isGeneratingThumbs = false;
                    try {
                        state.videoEl.pause();
                        state.videoEl.removeAttribute("src");
                        state.videoEl.load();
                    } catch {}
                    node.setDirtyCanvas(true, true);
                    return;
                }

                // If already loaded or in flight for this URL, skip redundant re-fetching to prevent tab-switch flicker
                if (
                    !forceRefresh &&
                    state.lastLoadedUrl === url
                ) {
                    node.setDirtyCanvas(true, true);
                    return;
                }

                const seq = ++state.loadSeq;
                state.lastLoadedUrl = url;
                state.videoLoaded = false;
                state.thumbnails = [];
                state.waveformPeaks = null;
                state.thumbSeq++; // cancel any in-flight thumbnail worker
                state.isGeneratingThumbs = false;

                try {
                    state.videoEl.pause();
                } catch {}
                state.videoEl.src = url;
                state.videoEl.load();

                if (state.videoEl.readyState >= 1) {
                    onVideoMetadataReady();
                }

                // Decode Audio for Waveform
                // The whole file is fetched and decoded into an AudioBuffer, so skip
                // the waveform for very large files instead of risking a tab OOM.
                fetch(url)
                    .then((res) => {
                        if (!res.ok) throw new Error("Audio fetch failed");
                        const length =
                            Number(res.headers.get("content-length")) || 0;
                        if (length > WAVEFORM_MAX_FILE_BYTES) {
                            res.body?.cancel?.();
                            throw new Error("Video too large for waveform");
                        }
                        return res.arrayBuffer();
                    })
                    .then((buf) => {
                        if (seq !== state.loadSeq) return;
                        const actx = getAudioContext();
                        if (!actx) return;
                        return actx.decodeAudioData(buf);
                    })
                    .then((audioBuf) => {
                        if (seq !== state.loadSeq || !audioBuf) return;
                        state.audioBuffer = audioBuf;
                        generateWaveformPeaks();
                        node.setDirtyCanvas(true, true);
                    })
                    .catch(() => {});
            }

            // Waveform generation
            function generateWaveformPeaks(numBuckets = 300) {
                if (!state.audioBuffer) return;
                const channelData = state.audioBuffer.getChannelData(0);
                const step = Math.floor(channelData.length / numBuckets);
                const peaks = new Float32Array(numBuckets);
                for (let i = 0; i < numBuckets; i++) {
                    const start = i * step;
                    const end = Math.min(start + step, channelData.length);
                    let max = 0;
                    for (let j = start; j < end; j++) {
                        const v = Math.abs(channelData[j]);
                        if (v > max) max = v;
                    }
                    peaks[i] = max;
                }
                state.waveformPeaks = peaks;
            }

            // Fast thumbnail generation across the video with loop-proof cleanup
            function generateThumbnails() {
                if (
                    !state.videoLoaded ||
                    state.isGeneratingThumbs ||
                    !state.videoEl.src
                )
                    return;
                const seq = ++state.thumbSeq;
                state.isGeneratingThumbs = true;
                state.thumbnails = [];

                let isCleanedUp = false;
                const offVideo = document.createElement("video");
                offVideo.preload = "auto";
                offVideo.crossOrigin = "anonymous";
                offVideo.muted = true;

                const cleanupOffVideo = () => {
                    if (isCleanedUp) return;
                    isCleanedUp = true;
                    try {
                        offVideo.pause();
                        offVideo.onloadedmetadata = null;
                        offVideo.onseeked = null;
                        offVideo.onerror = null;
                        offVideo.removeAttribute("src");
                    } catch {}
                };

                offVideo.addEventListener(
                    "error",
                    () => {
                        if (seq === state.thumbSeq) {
                            state.isGeneratingThumbs = false;
                        }
                        cleanupOffVideo();
                    },
                    { once: true },
                );

                offVideo.addEventListener(
                    "loadedmetadata",
                    () => {
                        if (seq !== state.thumbSeq) {
                            cleanupOffVideo();
                            return;
                        }
                        const count = Math.min(
                            24,
                            Math.max(8, Math.floor(state.totalFrames / 5)),
                        );
                        const stepSec = (state.duration || 1) / count;
                        let currentIdx = 0;

                        function captureNext() {
                            if (seq !== state.thumbSeq) {
                                cleanupOffVideo();
                                return;
                            }
                            if (currentIdx >= count) {
                                state.isGeneratingThumbs = false;
                                cleanupOffVideo();
                                node.setDirtyCanvas(true, true);
                                return;
                            }
                            const targetTime = currentIdx * stepSec;
                            offVideo.currentTime = targetTime;
                        }

                        offVideo.addEventListener("seeked", () => {
                            if (seq !== state.thumbSeq) {
                                cleanupOffVideo();
                                return;
                            }
                            try {
                                const thumbCanvas =
                                    document.createElement("canvas");
                                const thumbH = 64;
                                const thumbW =
                                    Math.round(
                                        (offVideo.videoWidth /
                                            (offVideo.videoHeight || 1)) *
                                            thumbH,
                                    ) || 96;
                                thumbCanvas.width = thumbW;
                                thumbCanvas.height = thumbH;
                                const tctx = thumbCanvas.getContext("2d");
                                tctx.drawImage(offVideo, 0, 0, thumbW, thumbH);

                                state.thumbnails.push({
                                    time: offVideo.currentTime,
                                    frame: Math.round(
                                        offVideo.currentTime * state.fps,
                                    ),
                                    canvas: thumbCanvas,
                                });
                            } catch {}

                            currentIdx++;
                            captureNext();
                        });

                        captureNext();
                    },
                    { once: true },
                );

                offVideo.src = state.videoEl.src;
            }

            // Seek video safely
            function seekVideo(time) {
                if (!state.videoLoaded) return;
                state.playheadTime = Math.max(
                    0,
                    Math.min(state.duration, time),
                );
                state.currentFrame = Math.round(state.playheadTime * state.fps);
                state.videoEl.currentTime = state.playheadTime;
                if (playheadWidget) playheadWidget.value = state.currentFrame;
                node.setDirtyCanvas(true, true);
            }

            // Playback loop
            function togglePlay() {
                if (!state.videoLoaded) return;
                state.isPlaying = !state.isPlaying;
                if (state.isPlaying) {
                    const startF = Number(startFrameWidget?.value) || 0;
                    const countF = Number(frameCountWidget?.value) || 0;
                    const endF =
                        countF > 0 ? startF + countF : state.totalFrames;
                    const endSec = endF / state.fps;

                    if (
                        state.playheadTime >= endSec - 0.05 ||
                        state.playheadTime >= state.duration - 0.05
                    ) {
                        seekVideo(startF / state.fps);
                    }
                    state.videoEl.playbackRate = state.playbackRate;
                    state.videoEl.muted = state.isMuted;
                    state.videoEl.volume = state.volume;

                    const p = state.videoEl.play();
                    if (p && typeof p.catch === "function") {
                        p.catch((err) => {
                            console.warn(
                                "[reference-loader] Playback error:",
                                err,
                            );
                            if (!state.videoEl.muted) {
                                // If browser blocked unmuted playback without prior user gesture, retry muted
                                state.videoEl.muted = true;
                                state.videoEl.play().catch(() => {
                                    state.isPlaying = false;
                                    node.setDirtyCanvas(true, true);
                                });
                            } else {
                                state.isPlaying = false;
                                node.setDirtyCanvas(true, true);
                            }
                        });
                    }
                    requestAnimationFrame(animStep);
                } else {
                    state.videoEl.pause();
                }
                node.setDirtyCanvas(true, true);
            }

            function animStep() {
                if (!state.isPlaying) return;
                // Auto-pause if node is no longer part of the active graph/workflow tab
                if (
                    !node.graph ||
                    (typeof app !== "undefined" &&
                        app.graph &&
                        node.graph !== app.graph)
                ) {
                    state.isPlaying = false;
                    try {
                        state.videoEl.pause();
                    } catch {}
                    node.setDirtyCanvas(true, true);
                    return;
                }

                state.playheadTime = state.videoEl.currentTime;
                state.currentFrame = Math.round(state.playheadTime * state.fps);
                if (playheadWidget) playheadWidget.value = state.currentFrame;

                const startF = Number(startFrameWidget?.value) || 0;
                const countF = Number(frameCountWidget?.value) || 0;
                const endF = countF > 0 ? startF + countF : state.totalFrames;

                if (state.currentFrame >= endF || state.videoEl.ended) {
                    if (state.isLooping) {
                        seekVideo(startF / state.fps);
                        state.videoEl.play().catch(() => {});
                    } else {
                        state.isPlaying = false;
                        state.videoEl.pause();
                    }
                }
                node.setDirtyCanvas(true, true);
                if (state.isPlaying) requestAnimationFrame(animStep);
            }

            let lastVideoVal = videoWidget?.value;
            if (videoWidget) {
                let internalVal = videoWidget.value;
                const valProp = Object.getOwnPropertyDescriptor(
                    videoWidget,
                    "value",
                );
                if (!valProp || valProp.configurable !== false) {
                    try {
                        Object.defineProperty(videoWidget, "value", {
                            get() {
                                return valProp && valProp.get
                                    ? valProp.get.call(videoWidget)
                                    : internalVal;
                            },
                            set(v) {
                                if (valProp && valProp.set) {
                                    valProp.set.call(videoWidget, v);
                                } else {
                                    internalVal = v;
                                }
                                if (
                                    videoWidget.options?.values &&
                                    !videoWidget.options.values.includes(v)
                                ) {
                                    videoWidget.options.values.push(v);
                                }
                                if (v !== lastVideoVal) {
                                    lastVideoVal = v;
                                    loadVideo(v);
                                }
                            },
                            configurable: true,
                            enumerable: true,
                        });
                    } catch (e) {}
                }

                const origCb = videoWidget.callback;
                videoWidget.callback = function (v) {
                    const cur = v !== undefined ? v : videoWidget.value;
                    if (cur !== lastVideoVal) {
                        lastVideoVal = cur;
                        loadVideo(cur);
                    }
                    cleanStockPreviewWidgets();
                    const ret = origCb?.apply(this, arguments);
                    cleanStockPreviewWidgets();
                    return ret;
                };
            }

            // Sync initial video value
            if (videoWidget?.value) {
                lastVideoVal = videoWidget.value;
                loadVideo(videoWidget.value);
            }

            const origOnConfigure = node.onConfigure;
            node.onConfigure = function () {
                node._was_configured = true;
                // Reset to custom type in case another extension overrode it
                if (!isVueMode()) {
                    node.previewMediaType = "custom";
                }
                const ret = origOnConfigure?.apply(this, arguments);
                node.onDrawBackground = function (_ctx) {
                    if (
                        node.widgets?.some(
                            (w) =>
                                w.name === "video-preview" ||
                                w.element?.querySelector?.("video"),
                        )
                    ) {
                        cleanStockPreviewWidgets();
                    }
                };
                cleanStockPreviewWidgets();
                // Schedule checks to catch any asynchronous core preview restorations
                requestAnimationFrame(cleanStockPreviewWidgets);
                setTimeout(cleanStockPreviewWidgets, 100);
                setTimeout(cleanStockPreviewWidgets, 500);
                // Restore saved crop from widget
                try {
                    const saved = cropWidget?.value
                        ? JSON.parse(cropWidget.value)
                        : null;
                    if (saved && (saved.w > 0 || saved.width > 0)) {
                        state.cropRect = {
                            x: saved.x || 0,
                            y: saved.y || 0,
                            w: saved.w || saved.width || 1,
                            h: saved.h || saved.height || 1,
                        };
                    } else {
                        state.cropRect = null;
                    }
                } catch {
                    state.cropRect = null;
                }

                // Restore saved playhead from widget
                const savedPlayhead = Number(playheadWidget?.value);
                if (Number.isFinite(savedPlayhead) && savedPlayhead >= 0) {
                    state.currentFrame = savedPlayhead;
                    state.playheadTime = savedPlayhead / state.fps;
                    if (state.videoLoaded) {
                        state.videoEl.currentTime = state.playheadTime;
                    }
                }

                if (videoWidget?.value) {
                    lastVideoVal = videoWidget.value;
                    loadVideo(videoWidget.value, false);
                }
                return ret;
            };

            const origOnExecuted = node.onExecuted;
            node.onExecuted = function () {
                const ret = origOnExecuted?.apply(this, arguments);
                cleanStockPreviewWidgets();
                requestAnimationFrame(cleanStockPreviewWidgets);
                setTimeout(cleanStockPreviewWidgets, 100);
                return ret;
            };

            function calcTransportLayout(w) {
                const btnH = 22;
                const gapX = 4;
                const gapY = 4;
                const pad = 4;
                const maxW = Math.max(60, w - pad * 2);

                const btns = [
                    { id: "stepBack", label: "⏮", tip: "Step -1 frame", w: 26 },
                    {
                        id: "play",
                        label: state.isPlaying ? "⏸" : "▶",
                        tip: "Play / Pause (Space)",
                        active: state.isPlaying,
                        w: 26,
                    },
                    { id: "stepFwd", label: "⏭", tip: "Step +1 frame", w: 26 },
                    {
                        id: "setIn",
                        label: "[ In",
                        tip: "Set In-point (I)",
                        w: 38,
                    },
                    {
                        id: "setOut",
                        label: "Out ]",
                        tip: "Set Out-point (O)",
                        w: 38,
                    },
                    {
                        id: "mark",
                        label: "📍 Mark",
                        tip: "Add / Toggle Freeze Marker (M)",
                        w: 50,
                    },
                    {
                        id: "loop",
                        label: "🔁",
                        tip: "Loop Playback",
                        active: state.isLooping,
                        w: 26,
                    },
                    {
                        id: "mute",
                        label: state.isMuted ? "🔇" : "🔊",
                        tip: "Toggle Mute (U)",
                        active: !state.isMuted,
                        w: 28,
                    },
                    {
                        id: "clearCrop",
                        label: "✕ Crop",
                        tip: "Clear Crop (C)",
                        active: !!state.cropRect,
                        w: 48,
                    },
                ];

                let curX = pad;
                let curY = 3;
                const layoutBtns = [];

                for (const b of btns) {
                    if (curX + b.w > maxW && curX > pad) {
                        curX = pad;
                        curY += btnH + gapY;
                    }
                    layoutBtns.push({ ...b, relX: curX, relY: curY, h: btnH });
                    curX += b.w + gapX;
                }

                const totalH = curY + btnH + 4;
                return { layoutBtns, btnH, totalH };
            }

            // Custom Timeline & Monitor Canvas Widget
            const customWidget = {
                type: "custom_video_timeline",
                name: "video_timeline_ui",
                value: "",
                serialize: false,
                options: { serialize: false },

                computeSize: function (width) {
                    return [
                        Math.max(width || 0, MIN_NODE_WIDTH),
                        CUSTOM_WIDGET_MIN_H,
                    ];
                },

                computeLayoutSize: function (_n) {
                    if (isVueMode()) {
                        const w = state.lastDrawW || (_n?.size?.[0] ?? MIN_NODE_WIDTH);
                        const availW = Math.max(100, w - MARGIN * 2);
                        const vw = state.videoWidth || 16;
                        const vh = state.videoHeight || 9;
                        const monitorH = Math.max(80, availW * (vh / vw));
                        const infoH = state.videoLoaded ? 18 : 0;
                        const transportLayout = calcTransportLayout(availW);
                        const h = monitorH + 110 + (infoH > 0 ? infoH + 4 : 0) + transportLayout.totalH + 20;
                        return { minHeight: h, maxHeight: h, minWidth: 0 };
                    }
                    return {
                        minHeight: CUSTOM_WIDGET_MIN_H,
                        maxHeight: 100000,
                        minWidth: MIN_NODE_WIDTH,
                    };
                },

                draw(ctx, node, widgetWidth, y, _widgetHeight) {
                    if (isVueMode()) {
                        syncVueHelpUI(node, state);
                    }
                    if (videoWidget && videoWidget.value !== lastVideoVal) {
                        lastVideoVal = videoWidget.value;
                        loadVideo(lastVideoVal);
                    }
                    const nw = node?.size?.[0] || widgetWidth || MIN_NODE_WIDTH;
                    const effWidth = !isVueMode() && nw ? Math.min(widgetWidth, nw) : widgetWidth;
                    state.lastDrawW = effWidth;
                    const nh = node?.size?.[1] || MIN_NODE_HEIGHT;
                    const margin = MARGIN;
                    const availW = Math.max(100, effWidth - margin * 2);
                    
                    const actualH = isVueMode() ? (this.computedHeight ?? _widgetHeight) : (nh - y - margin);
                    const availH = Math.max(
                        CUSTOM_WIDGET_MIN_H,
                        actualH
                    );

                    // Video Info String
                    const tcStr = `${formatTimecode(state.playheadTime, state.fps)} [${state.currentFrame}f]`;
                    const resStr = `${state.videoWidth}x${state.videoHeight} @ ${state.fps.toFixed(1)}fps`;
                    const fullInfoStr = state.videoLoaded
                        ? `${tcStr}  •  ${resStr}`
                        : "";
                    const infoH = fullInfoStr ? 18 : 0;

                    // Calculate dynamic transport toolbar height
                    const transportLayout = calcTransportLayout(availW);
                    const transportH = transportLayout.totalH;

                    // Fixed compact timeline height
                    const timelineH = 110;
                    // Monitor expands dynamically to take ALL remaining available vertical space!
                    const monitorH = Math.max(
                        80,
                        availH -
                            timelineH -
                            (infoH > 0 ? infoH + 4 : 0) -
                            transportH -
                            12,
                    );

                    const monX = margin;
                    const monY = y + 4;
                    const monW = availW;

                    const timeX = margin;
                    const timeY = monY + monitorH + 4;
                    const timeW = availW;

                    let curPartY = timeY + timelineH + 4;

                    const infoX = margin;
                    const infoY = curPartY;
                    const infoW = availW;
                    if (infoH > 0) {
                        curPartY += infoH + 4;
                    }

                    const transX = margin;
                    const transY = curPartY;
                    const transW = availW;

                    // 1. Draw Monitor (Live Video Preview & Interactive Crop Overlay)
                    drawMonitor(ctx, monX, monY, monW, monitorH);

                    // 2. Draw Timeline (Ruler, Quantize ticks, Thumbnails, Waveform, In/Out handles, Playhead)
                    drawTimeline(ctx, timeX, timeY, timeW, timelineH);

                    // 3. Draw Dedicated Information Text Line Element (under timeline)
                    if (infoH > 0) {
                        drawInfoBar(
                            ctx,
                            infoX,
                            infoY,
                            infoW,
                            infoH,
                            fullInfoStr,
                        );
                    }

                    // 4. Draw Transport Toolbar UI (bottom)
                    drawTransport(
                        ctx,
                        transX,
                        transY,
                        transW,
                        transportH,
                        transportLayout,
                    );
                },
            };

            // In Vue (Nodes 2.0) mode the widget mirror prefers computedHeight
            // over computeSize — but computedHeight is a stale graph-units
            // value from the canvas-mode layout. Hide it there so the mirror
            // falls back to computeSize with the card's real CSS width.
            {
                let storedHeight;
                try {
                    const chProp = Object.getOwnPropertyDescriptor(
                        customWidget,
                        "computedHeight",
                    );
                    if (!chProp || chProp.configurable !== false) {
                        Object.defineProperty(customWidget, "computedHeight", {
                            configurable: true,
                            get() {
                                return isVueMode() ? undefined : storedHeight;
                            },
                            set(v) {
                                storedHeight = v;
                            },
                        });
                    }
                } catch (e) {}
            }

            // Draw Top Monitor Canvas with Interactive Crop Box
            function drawMonitor(ctx, x, y, w, h) {
                // Background plate
                drawRoundRect(ctx, x, y, w, h, 6);
                ctx.fillStyle = C.bg;
                ctx.fill();
                ctx.strokeStyle = C.border;
                ctx.lineWidth = 1;
                ctx.stroke();

                if (!state.videoLoaded) {
                    ctx.fillStyle = C.textDim;
                    ctx.font = "12px sans-serif";
                    ctx.textAlign = "center";
                    ctx.textBaseline = "middle";
                    if (state.videoEl.src) {
                        ctx.fillText(
                            "Loading video preview...",
                            x + w / 2,
                            y + h / 2,
                        );
                    } else {
                        ctx.fillText(
                            "No video loaded. Select or upload a video file.",
                            x + w / 2,
                            y + h / 2,
                        );
                    }
                    state.monitorBox = null;
                    return;
                }

                // Dedicated Top Header / Status Bar (Height: 22px)
                const headerH = 22;
                ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
                ctx.fillRect(x + 1, y + 1, w - 2, headerH);
                ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
                ctx.beginPath();
                ctx.moveTo(x + 1, y + headerH + 1);
                ctx.lineTo(x + w - 1, y + headerH + 1);
                ctx.stroke();

                // Left Header Title
                ctx.font = "10px sans-serif";
                ctx.textAlign = "left";
                ctx.fillStyle = C.textDim;
                const aspectLabel =
                    aspectWidget?.value &&
                    String(aspectWidget.value).toLowerCase() !== "none"
                        ? ` [${aspectWidget.value}]`
                        : "";
                ctx.fillText(`PREVIEW MONITOR${aspectLabel}`, x + 8, y + 15);

                // Right Header: Crop info if active
                if (state.cropRect) {
                    const srcW = Math.round(
                        state.cropRect.w * state.videoWidth,
                    );
                    const srcH = Math.round(
                        state.cropRect.h * state.videoHeight,
                    );
                    ctx.font = "10px sans-serif";
                    ctx.textAlign = "right";
                    ctx.fillStyle = C.accent;
                    ctx.fillText(`Crop: ${srcW}x${srcH}`, x + w - 8, y + 15);
                }

                // Video Viewport Area
                const viewPad = 4;
                const viewX = x + viewPad;
                const viewY = y + headerH + viewPad;
                const viewW = w - viewPad * 2;
                const viewH = h - headerH - viewPad * 2;

                if (viewW <= 0 || viewH <= 0) return;

                const vw = state.videoWidth || 1;
                const vh = state.videoHeight || 1;
                const scale = Math.min(viewW / vw, viewH / vh);
                const dw = vw * scale;
                const dh = vh * scale;
                const dx = viewX + (viewW - dw) / 2;
                const dy = viewY + (viewH - dh) / 2;

                state.monitorBox = { bx: dx, by: dy, bw: dw, bh: dh };

                // Draw video frame
                ctx.save();
                drawRoundRect(ctx, dx, dy, dw, dh, 4);
                ctx.clip();
                ctx.drawImage(state.videoEl, dx, dy, dw, dh);
                ctx.restore();

                // Video frame boundary outline
                ctx.strokeStyle = "rgba(255, 255, 255, 0.1)";
                ctx.lineWidth = 1;
                drawRoundRect(ctx, dx, dy, dw, dh, 4);
                ctx.stroke();

                // Draw Spatial Crop Overlay
                if (state.cropRect) {
                    const sx = dx + state.cropRect.x * dw;
                    const sy = dy + state.cropRect.y * dh;
                    const sw = state.cropRect.w * dw;
                    const sh = state.cropRect.h * dh;

                    // Dim outside region
                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(dx, dy, dw, dh);
                    ctx.rect(sx, sy, sw, sh);
                    ctx.fillStyle = C.cropShade;
                    ctx.fill("evenodd");
                    ctx.restore();

                    // Crop rectangle border
                    ctx.strokeStyle = C.cropBorder;
                    ctx.lineWidth = 1.5;
                    ctx.strokeRect(sx, sy, sw, sh);

                    // 8 Resize Handles (4 Corners + 4 Edges)
                    ctx.fillStyle = C.cropHandle;
                    ctx.strokeStyle = C.cropBorder;
                    ctx.lineWidth = 1.5;
                    const handles = [
                        [sx, sy],
                        [sx + sw, sy],
                        [sx, sy + sh],
                        [sx + sw, sy + sh],
                        [sx + sw / 2, sy],
                        [sx + sw / 2, sy + sh],
                        [sx, sy + sh / 2],
                        [sx + sw, sy + sh / 2],
                    ];
                    for (const [hx, hy] of handles) {
                        ctx.fillRect(hx - 3, hy - 3, 6, 6);
                        ctx.strokeRect(hx - 3, hy - 3, 6, 6);
                    }

                    // Dimension Pill Above / Below Selection
                    const [pw, ph] = cropDims();
                    const pillH = 14;
                    ctx.font = "10px sans-serif";

                    // Crop source size pill (top)
                    const cropText = `${pw} x ${ph}`;
                    const ctw = ctx.measureText(cropText).width;
                    const ptx = Math.max(
                        dx,
                        Math.min(sx + (sw - ctw - 8) / 2, dx + dw - ctw - 8),
                    );
                    const pty = sy > dy + pillH + 4 ? sy - 4 : sy + pillH + 2;

                    drawRoundRect(ctx, ptx, pty - pillH + 2, ctw + 8, pillH, 3);
                    ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
                    ctx.fill();
                    ctx.strokeStyle = C.border;
                    ctx.stroke();

                    ctx.fillStyle = "#ffffff";
                    ctx.textAlign = "left";
                    ctx.textBaseline = "alphabetic";
                    ctx.fillText(cropText, ptx + 4, pty - 1);

                    // Output size pill (bottom, if capped)
                    const capped = cappedDims(pw, ph);
                    if (capped) {
                        const outText = `Output: ${capped[0]} x ${capped[1]}`;
                        const otw = ctx.measureText(outText).width;
                        const otx = Math.max(
                            dx,
                            Math.min(
                                sx + (sw - otw - 8) / 2,
                                dx + dw - otw - 8,
                            ),
                        );
                        const belowY = sy + sh + pillH + 2;
                        const oty = belowY < dy + dh - 2 ? belowY : sy + sh - 4;

                        drawRoundRect(
                            ctx,
                            otx,
                            oty - pillH + 2,
                            otw + 8,
                            pillH,
                            3,
                        );
                        ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
                        ctx.fill();
                        ctx.strokeStyle = C.border;
                        ctx.stroke();

                        ctx.fillStyle = C.accent;
                        ctx.fillText(outText, otx + 4, oty - 1);
                    }
                }
            }

            // Draw Dedicated Information Text Line Element (under timeline)
            function drawInfoBar(ctx, x, y, w, h, fullInfoStr) {
                if (!fullInfoStr) return;
                drawRoundRect(ctx, x, y, w, h, 3);
                ctx.fillStyle = "rgba(21, 24, 30, 0.75)";
                ctx.fill();
                ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
                ctx.lineWidth = 1;
                ctx.stroke();

                ctx.font = "10px monospace";
                ctx.textAlign = "right";
                ctx.textBaseline = "middle";
                ctx.fillStyle = C.accent;
                ctx.fillText(fullInfoStr, x + w - 8, y + h / 2);
            }

            // Draw Transport Toolbar (pure buttons UI)
            function drawTransport(ctx, x, y, w, h, layout) {
                drawRoundRect(ctx, x, y, w, h, 4);
                ctx.fillStyle = C.panelBg;
                ctx.fill();
                ctx.strokeStyle = C.border;
                ctx.stroke();

                ctx.font = "11px sans-serif";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";

                const stateBtns = [];
                for (const btn of layout.layoutBtns) {
                    const bx = x + btn.relX;
                    const by = y + btn.relY;
                    const bw = btn.w;
                    const bh = btn.h;
                    const isHover = state.hoverBtn === btn.id;
                    const isActive = btn.active;

                    drawRoundRect(ctx, bx, by, bw, bh, 3);
                    ctx.fillStyle = isActive
                        ? C.accent
                        : isHover
                          ? C.btnHover
                          : C.btnBg;
                    ctx.fill();
                    ctx.strokeStyle = isActive ? C.accentGlow : C.border;
                    ctx.stroke();

                    ctx.fillStyle = isActive
                        ? "#000"
                        : isHover
                          ? "#fff"
                          : C.text;
                    ctx.fillText(btn.label, bx + bw / 2, by + bh / 2);

                    stateBtns.push({
                        id: btn.id,
                        rect: { x: bx, y: by, w: bw, h: bh },
                    });
                }
                state.transportBtns = stateBtns;
            }

            // Draw Detailed Filmstrip Timeline
            function drawTimeline(ctx, x, y, w, h) {
                drawRoundRect(ctx, x, y, w, h, 6);
                ctx.fillStyle = C.bg;
                ctx.fill();
                ctx.strokeStyle = C.border;
                ctx.lineWidth = 1;
                ctx.stroke();

                if (!state.videoLoaded) {
                    ctx.fillStyle = C.textDim;
                    ctx.font = "11px sans-serif";
                    ctx.textAlign = "center";
                    ctx.textBaseline = "middle";
                    ctx.fillText(
                        "Timeline track will appear once video is loaded",
                        x + w / 2,
                        y + h / 2,
                    );
                    state.timelineBounds = null;
                    return;
                }

                const trackX = x + 4;
                const trackW = w - 8;
                const rulerY = y + 2;
                const filmY = rulerY + RULER_H;
                const filmH = FILMSTRIP_H;
                const waveY = filmY + filmH;
                const waveH = WAVEFORM_H;

                const totalF = state.totalFrames || 1;
                const frameToX = (f) => trackX + (f / totalF) * trackW;
                const xToFrame = (px) =>
                    Math.max(
                        0,
                        Math.min(
                            totalF,
                            Math.round(((px - trackX) / trackW) * totalF),
                        ),
                    );

                // 1. Timecode & Quantization Ruler
                ctx.fillStyle = C.panelBg;
                ctx.fillRect(trackX, rulerY, trackW, RULER_H);

                ctx.font = "9px monospace";
                ctx.textBaseline = "middle";

                // Dynamically calculate friendly step intervals so labels never overlap regardless of video length or node size
                const minLabelPx = 54;
                const maxLabels = Math.max(2, Math.floor(trackW / minLabelPx));
                const rawStep = totalF / maxLabels;

                const niceSteps = [
                    1, 2, 5, 10, 15, 20, 24, 30, 48, 60, 75, 90, 120, 150, 180,
                    240, 300, 600, 900, 1200, 1800, 2400, 3600, 7200, 14400,
                    28800,
                ];

                let stepFrames = niceSteps[niceSteps.length - 1];
                for (const s of niceSteps) {
                    if (s >= rawStep) {
                        stepFrames = s;
                        break;
                    }
                }
                if (rawStep > niceSteps[niceSteps.length - 1]) {
                    const magnitude = Math.pow(
                        10,
                        Math.floor(Math.log10(rawStep)),
                    );
                    const residual = rawStep / magnitude;
                    stepFrames =
                        (residual <= 2 ? 2 : residual <= 5 ? 5 : 10) *
                        magnitude;
                }

                // Draw minor ticks first (if stepFrames > 2)
                const minorStep =
                    stepFrames >= 30
                        ? stepFrames % 5 === 0
                            ? stepFrames / 5
                            : stepFrames / 2
                        : stepFrames >= 10
                          ? stepFrames / 2
                          : 0;
                if (minorStep > 0) {
                    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    for (let f = 0; f <= totalF; f += minorStep) {
                        if (f % stepFrames !== 0) {
                            const rx = frameToX(f);
                            ctx.moveTo(rx, rulerY + RULER_H - 3);
                            ctx.lineTo(rx, rulerY + RULER_H);
                        }
                    }
                    ctx.stroke();
                }

                // Draw major labeled ticks
                for (let f = 0; f <= totalF; f += stepFrames) {
                    const rx = frameToX(f);
                    ctx.strokeStyle = C.border;
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(rx, rulerY + RULER_H - 5);
                    ctx.lineTo(rx, rulerY + RULER_H);
                    ctx.stroke();

                    ctx.fillStyle = C.textDim;
                    if (f === 0) {
                        ctx.textAlign = "left";
                        ctx.fillText("0f", rx + 2, rulerY + 8);
                    } else if (
                        f + stepFrames > totalF &&
                        Math.abs(rx - (trackX + trackW)) < 25
                    ) {
                        ctx.textAlign = "right";
                        ctx.fillText(`${f}f`, rx - 2, rulerY + 8);
                    } else {
                        ctx.textAlign = "center";
                        ctx.fillText(`${f}f`, rx, rulerY + 8);
                    }
                }

                // Quantization ticks overlay (e.g. 4n+1, 8n+1, 17n+5)
                const qPreset = QUANTIZE_PRESETS[quantizeWidget?.value];
                if (qPreset) {
                    const { step, offset } = qPreset;
                    const startF = Number(startFrameWidget?.value) || 0;
                    ctx.strokeStyle = C.quantizeTick;
                    ctx.lineWidth = 1;
                    for (let n = 0; ; n++) {
                        const targetF = startF + (n * step + offset);
                        if (targetF > totalF) break;
                        const qx = frameToX(targetF);
                        ctx.beginPath();
                        ctx.moveTo(qx, rulerY + RULER_H - 8);
                        ctx.lineTo(qx, rulerY + RULER_H);
                        ctx.stroke();
                    }
                }

                // 2. Filmstrip Track
                ctx.fillStyle = "#0c0d11";
                ctx.fillRect(trackX, filmY, trackW, filmH);

                if (state.thumbnails.length > 0) {
                    const thumbCount = state.thumbnails.length;
                    const singleW = trackW / thumbCount;
                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(trackX, filmY, trackW, filmH);
                    ctx.clip();

                    state.thumbnails.forEach((t, i) => {
                        const tx = trackX + i * singleW;
                        ctx.drawImage(t.canvas, tx, filmY, singleW, filmH);
                        ctx.strokeStyle = "rgba(0,0,0,0.3)";
                        ctx.strokeRect(tx, filmY, singleW, filmH);
                    });
                    ctx.restore();
                }

                // 3. Audio Waveform Track
                ctx.fillStyle = "#090a0d";
                ctx.fillRect(trackX, waveY, trackW, waveH);

                if (state.waveformPeaks) {
                    const peaks = state.waveformPeaks;
                    const numBars = peaks.length;
                    const step = trackW / numBars;
                    const centerY = waveY + waveH / 2;

                    ctx.fillStyle = C.waveBody;
                    for (let i = 0; i < numBars; i++) {
                        const barX = trackX + i * step;
                        const amp = peaks[i];
                        const bh = Math.max(1, amp * (waveH - 4));
                        ctx.fillRect(
                            barX,
                            centerY - bh / 2,
                            Math.max(1, step - 0.5),
                            bh,
                        );
                    }
                }

                // 4. In / Out Trim Region & Shading
                const inF = Number(startFrameWidget?.value) || 0;
                const countF = Number(frameCountWidget?.value) || totalF - inF;
                const outF = inF + countF;

                const inX = frameToX(inF);
                const outX = frameToX(outF);

                // Shading outside trimmed region
                ctx.fillStyle = C.inOutShade;
                if (inX > trackX)
                    ctx.fillRect(trackX, filmY, inX - trackX, filmH + waveH);
                if (outX < trackX + trackW)
                    ctx.fillRect(
                        outX,
                        filmY,
                        trackX + trackW - outX,
                        filmH + waveH,
                    );

                // Trim boundary markers
                ctx.strokeStyle = C.inOutHandle;
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(inX, rulerY);
                ctx.lineTo(inX, waveY + waveH);
                ctx.moveTo(outX, rulerY);
                ctx.lineTo(outX, waveY + waveH);
                ctx.stroke();

                // In/Out Grab Handles
                drawRoundRect(ctx, inX - 5, rulerY + 2, 10, RULER_H - 4, 3);
                ctx.fillStyle = C.inOutHandle;
                ctx.fill();
                ctx.fillStyle = "#000";
                ctx.font = "bold 9px sans-serif";
                ctx.fillText("[", inX, rulerY + RULER_H / 2);

                drawRoundRect(ctx, outX - 5, rulerY + 2, 10, RULER_H - 4, 3);
                ctx.fillStyle = C.inOutHandle;
                ctx.fill();
                ctx.fillStyle = "#000";
                ctx.fillText("]", outX, rulerY + RULER_H / 2);

                // 5. Freeze / Action Markers
                const markStr = String(markersWidget?.value || "");
                if (markStr) {
                    const list = markStr
                        .split(",")
                        .map((s) => Number(s.trim()))
                        .filter((n) => Number.isFinite(n));
                    list.forEach((mf) => {
                        const mx = frameToX(mf);
                        ctx.fillStyle = C.marker;
                        ctx.beginPath();
                        ctx.moveTo(mx - 4, rulerY + 2);
                        ctx.lineTo(mx + 4, rulerY + 2);
                        ctx.lineTo(mx, rulerY + 8);
                        ctx.closePath();
                        ctx.fill();

                        ctx.strokeStyle = C.marker;
                        ctx.lineWidth = 1;
                        ctx.beginPath();
                        ctx.moveTo(mx, rulerY + 8);
                        ctx.lineTo(mx, waveY + waveH);
                        ctx.stroke();
                    });
                }

                // 6. Playhead Scrubber Needle
                const playX = frameToX(state.currentFrame);
                ctx.fillStyle = C.playhead;
                ctx.beginPath();
                ctx.moveTo(playX - 5, rulerY);
                ctx.lineTo(playX + 5, rulerY);
                ctx.lineTo(playX, rulerY + 9);
                ctx.closePath();
                ctx.fill();

                ctx.strokeStyle = C.playhead;
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(playX, rulerY + 8);
                ctx.lineTo(playX, waveY + waveH);
                ctx.stroke();

                state.timelineBounds = {
                    x: trackX,
                    y: rulerY,
                    w: trackW,
                    h: RULER_H + filmH + waveH,
                    inX,
                    outX,
                    playX,
                    frameToX,
                    xToFrame,
                };
            }

            // Helper to check if this video node is currently active / focused
            function isNodeActive() {
                // Must belong to the currently active graph/workflow tab
                if (
                    !node.graph ||
                    (typeof app !== "undefined" &&
                        app.graph &&
                        node.graph !== app.graph)
                ) {
                    return false;
                }

                // Ignore when user is actively editing text in inputs or textareas
                const activeEl = document.activeElement;
                if (activeEl) {
                    const tag = activeEl.tagName;
                    if (
                        tag === "INPUT" ||
                        tag === "TEXTAREA" ||
                        tag === "SELECT" ||
                        activeEl.isContentEditable
                    ) {
                        return false;
                    }
                }

                // Mouse hovered directly over node or controls
                if (
                    app?.canvas?.node_over === node ||
                    state.helpHovered ||
                    state.helpBadgeHovered ||
                    state.helpOpen ||
                    state.hoverBtn
                ) {
                    return true;
                }

                // Explicitly selected in LiteGraph / ComfyUI
                if (node.is_selected) return true;
                if (app?.canvas?.current_node === node) return true;
                if (app?.canvas?.selected_node === node) return true;

                const sel = app?.canvas?.selected_nodes;
                if (sel) {
                    if (typeof sel.has === "function") {
                        if (
                            sel.has(node.id) ||
                            sel.has(String(node.id)) ||
                            sel.has(node)
                        )
                            return true;
                    } else if (Array.isArray(sel)) {
                        if (
                            sel.includes(node) ||
                            sel.includes(node.id) ||
                            sel.includes(String(node.id))
                        )
                            return true;
                    } else if (typeof sel === "object") {
                        if (sel[node.id] || sel[String(node.id)]) return true;
                    }
                }

                // Tracked as last interacted reference-loader node
                if (window.__referenceLoaderActiveNode === node.id) {
                    const curr = app?.canvas?.current_node;
                    if (curr === node) {
                        return true;
                    }
                }

                return false;
            }

            // Keyboard Shortcuts
            const onKeyDown = (e) => {
                if (!isNodeActive()) return;

                const key = e.key;
                const code = e.code;

                if (
                    code === "Space" ||
                    key === " " ||
                    key === "Spacebar" ||
                    e.keyCode === 32
                ) {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    togglePlay();
                } else if (
                    code === "ArrowLeft" ||
                    key === "ArrowLeft" ||
                    code === "BracketLeft" ||
                    key === "["
                ) {
                    e.preventDefault();
                    e.stopPropagation();
                    seekVideo((state.currentFrame - 1) / state.fps);
                } else if (
                    code === "ArrowRight" ||
                    key === "ArrowRight" ||
                    code === "BracketRight" ||
                    key === "]"
                ) {
                    e.preventDefault();
                    e.stopPropagation();
                    seekVideo((state.currentFrame + 1) / state.fps);
                } else if (key === "i" || key === "I" || code === "KeyI") {
                    e.preventDefault();
                    e.stopPropagation();
                    if (startFrameWidget) {
                        startFrameWidget.value = state.currentFrame;
                        node.setDirtyCanvas(true, true);
                    }
                } else if (key === "o" || key === "O" || code === "KeyO") {
                    e.preventDefault();
                    e.stopPropagation();
                    if (startFrameWidget && frameCountWidget) {
                        const inF = Number(startFrameWidget.value) || 0;
                        const outF = Math.max(inF + 1, state.currentFrame);
                        frameCountWidget.value = outF - inF;
                        node.setDirtyCanvas(true, true);
                    }
                } else if (key === "m" || key === "M" || code === "KeyM") {
                    e.preventDefault();
                    e.stopPropagation();
                    toggleMarkerAtCurrent(e.shiftKey);
                } else if (key === "u" || key === "U" || code === "KeyU") {
                    e.preventDefault();
                    e.stopPropagation();
                    state.isMuted = !state.isMuted;
                    state.videoEl.muted = state.isMuted;
                    node.setDirtyCanvas(true, true);
                } else if (key === "c" || key === "C" || code === "KeyC") {
                    e.preventDefault();
                    e.stopPropagation();
                    state.cropRect = null;
                    syncCrop();
                }
            };
            window.addEventListener("keydown", onKeyDown, { capture: true });

            function toggleMarkerAtCurrent(clearAll = false) {
                if (!markersWidget) return;
                if (clearAll) {
                    markersWidget.value = "";
                    node.setDirtyCanvas(true, true);
                    return;
                }
                const cur = state.currentFrame;
                const mList = String(markersWidget.value || "")
                    .split(",")
                    .map((s) => Number(s.trim()))
                    .filter((n) => Number.isFinite(n));

                const set = new Set(mList);
                if (set.has(cur)) set.delete(cur);
                else set.add(cur);

                const sorted = Array.from(set).sort((a, b) => a - b);
                markersWidget.value = sorted.join(", ");
                node.setDirtyCanvas(true, true);
            }

            // ================================================================
            // Mouse & Pointer Interactions on Custom Widget and Node
            // ================================================================
            function handleMouseDown(e, [px, py]) {
                window.__referenceLoaderActiveNode = node.id;
                node.is_selected = true;
                if (typeof app !== "undefined" && app.canvas) {
                    if (typeof app.canvas.selectNode === "function")
                        app.canvas.selectNode(node);
                    app.canvas.current_node = node;
                }

                // 1. Check Transport buttons
                if (state.transportBtns) {
                    for (const btn of state.transportBtns) {
                        if (
                            px >= btn.rect.x &&
                            px <= btn.rect.x + btn.rect.w &&
                            py >= btn.rect.y &&
                            py <= btn.rect.y + btn.rect.h
                        ) {
                            if (btn.id === "play") {
                                togglePlay();
                            } else if (btn.id === "stepBack") {
                                seekVideo((state.currentFrame - 1) / state.fps);
                            } else if (btn.id === "stepFwd") {
                                seekVideo((state.currentFrame + 1) / state.fps);
                            } else if (btn.id === "setIn") {
                                if (startFrameWidget)
                                    startFrameWidget.value = state.currentFrame;
                            } else if (btn.id === "setOut") {
                                if (startFrameWidget && frameCountWidget) {
                                    const inF =
                                        Number(startFrameWidget.value) || 0;
                                    const outF = Math.max(
                                        inF + 1,
                                        state.currentFrame,
                                    );
                                    frameCountWidget.value = outF - inF;
                                }
                            } else if (btn.id === "mark") {
                                toggleMarkerAtCurrent(e.shiftKey);
                            } else if (btn.id === "loop") {
                                state.isLooping = !state.isLooping;
                            } else if (btn.id === "mute") {
                                state.isMuted = !state.isMuted;
                                state.videoEl.muted = state.isMuted;
                            } else if (btn.id === "clearCrop") {
                                state.cropRect = null;
                                syncCrop();
                            }

                            node.setDirtyCanvas(true, true);
                            return true;
                        }
                    }
                }

                // 2. Check Timeline Drag Targets & Marker Pins
                const tb = state.timelineBounds;
                if (
                    tb &&
                    px >= tb.x - 10 &&
                    px <= tb.x + tb.w + 10 &&
                    py >= tb.y &&
                    py <= tb.y + tb.h
                ) {
                    // Check if clicked directly on an existing marker flag on the ruler
                    if (py <= tb.y + RULER_H + 4 && markersWidget?.value) {
                        const mList = String(markersWidget.value)
                            .split(",")
                            .map((s) => Number(s.trim()))
                            .filter((n) => Number.isFinite(n));
                        for (const mf of mList) {
                            const mx = tb.frameToX(mf);
                            if (Math.abs(px - mx) <= 6) {
                                seekVideo(mf / state.fps);
                                toggleMarkerAtCurrent(false); // Removes this marker
                                node.setDirtyCanvas(true, true);
                                return true;
                            }
                        }
                    }

                    if (Math.abs(px - tb.inX) <= HANDLE_RADIUS) {
                        state.dragTarget = "inPoint";
                    } else if (Math.abs(px - tb.outX) <= HANDLE_RADIUS) {
                        state.dragTarget = "outPoint";
                    } else if (Math.abs(px - tb.playX) <= HANDLE_RADIUS + 4) {
                        state.dragTarget = "playhead";
                    } else {
                        const targetF = tb.xToFrame(px);
                        seekVideo(targetF / state.fps);
                        state.dragTarget = "playhead";
                    }
                    state.dragStartX = px;
                    state.dragStartY = py;
                    node.setDirtyCanvas(true, true);
                    return true;
                }

                // 3. Check Monitor Spatial Crop Interactions
                const mb = state.monitorBox;
                if (
                    mb &&
                    px >= mb.bx &&
                    px <= mb.bx + mb.bw &&
                    py >= mb.by &&
                    py <= mb.by + mb.bh
                ) {
                    const hit = hitTestCrop(px, py);
                    state.dragTarget = "crop";
                    state.cropDrag = {
                        ...hit,
                        startX: px,
                        startY: py,
                        origRect: state.cropRect ? { ...state.cropRect } : null,
                        moved: false,
                    };
                    node.setDirtyCanvas(true, true);
                    return true;
                }

                return false;
            }

            function handleMouseMove(e, [px, py]) {
                // Safety: if mouse button is not currently down, release any active drag targets
                const isMouseDown =
                    e && typeof e.buttons === "number" ? e.buttons > 0 : true;
                if (state.dragTarget && !isMouseDown) {
                    if (state.dragTarget === "crop") {
                        if (
                            state.cropDrag?.mode === "new" &&
                            !state.cropDrag.moved
                        ) {
                            state.cropRect = null;
                        }
                        syncCrop();
                        state.cropDrag = null;
                    }
                    state.dragTarget = null;
                    node.setDirtyCanvas(true, true);
                }

                // Check button hover state
                let hovered = null;
                if (state.transportBtns) {
                    for (const btn of state.transportBtns) {
                        if (
                            px >= btn.rect.x &&
                            px <= btn.rect.x + btn.rect.w &&
                            py >= btn.rect.y &&
                            py <= btn.rect.y + btn.rect.h
                        ) {
                            hovered = btn.id;
                            break;
                        }
                    }
                }
                if (hovered !== state.hoverBtn) {
                    state.hoverBtn = hovered;
                    node.setDirtyCanvas(true, true);
                }

                // Handle active dragging on timeline
                if (
                    state.dragTarget === "playhead" ||
                    state.dragTarget === "inPoint" ||
                    state.dragTarget === "outPoint"
                ) {
                    if (state.timelineBounds) {
                        const tb = state.timelineBounds;
                        const frame = tb.xToFrame(px);

                        if (state.dragTarget === "playhead") {
                            seekVideo(frame / state.fps);
                        } else if (
                            state.dragTarget === "inPoint" &&
                            startFrameWidget &&
                            frameCountWidget
                        ) {
                            const inF = Math.max(
                                0,
                                Math.min(state.totalFrames - 1, frame),
                            );
                            const currentOut =
                                (Number(startFrameWidget.value) || 0) +
                                (Number(frameCountWidget.value) ||
                                    state.totalFrames);
                            const newCount = Math.max(1, currentOut - inF);
                            startFrameWidget.value = inF;
                            frameCountWidget.value = newCount;
                        } else if (
                            state.dragTarget === "outPoint" &&
                            startFrameWidget &&
                            frameCountWidget
                        ) {
                            const inF = Number(startFrameWidget.value) || 0;
                            const outF = Math.max(
                                inF + 1,
                                Math.min(state.totalFrames, frame),
                            );
                            frameCountWidget.value = outF - inF;
                        }
                        node.setDirtyCanvas(true, true);
                        return true;
                    }
                }

                // Handle active spatial crop dragging
                if (
                    state.dragTarget === "crop" &&
                    state.cropDrag &&
                    state.monitorBox
                ) {
                    const drag = state.cropDrag;
                    const mb = state.monitorBox;
                    const clampX = (v) =>
                        Math.max(mb.bx, Math.min(mb.bx + mb.bw, v));
                    const clampY = (v) =>
                        Math.max(mb.by, Math.min(mb.by + mb.bh, v));

                    if (
                        Math.abs(px - drag.startX) +
                            Math.abs(py - drag.startY) >
                        2
                    ) {
                        drag.moved = true;
                    }

                    if (drag.mode === "new") {
                        const targetRatio = getTargetAspectRatio();
                        if (!targetRatio) {
                            const x0 = clampX(Math.min(drag.startX, px));
                            const y0 = clampY(Math.min(drag.startY, py));
                            const x1 = clampX(Math.max(drag.startX, px));
                            const y1 = clampY(Math.max(drag.startY, py));
                            if (
                                x1 - x0 >= MIN_SEL_PX &&
                                y1 - y0 >= MIN_SEL_PX
                            ) {
                                state.cropRect = {
                                    x: (x0 - mb.bx) / mb.bw,
                                    y: (y0 - mb.by) / mb.bh,
                                    w: (x1 - x0) / mb.bw,
                                    h: (y1 - y0) / mb.bh,
                                };
                            }
                        } else {
                            const dx = px - drag.startX;
                            const dy = py - drag.startY;
                            const signX = dx >= 0 ? 1 : -1;
                            const signY = dy >= 0 ? 1 : -1;

                            const maxW =
                                signX > 0
                                    ? mb.bx + mb.bw - drag.startX
                                    : drag.startX - mb.bx;
                            const maxH =
                                signY > 0
                                    ? mb.by + mb.bh - drag.startY
                                    : drag.startY - mb.by;

                            const maxW_allowed = Math.max(
                                0,
                                Math.min(maxW, maxH * targetRatio),
                            );
                            const maxH_allowed = Math.max(
                                0,
                                Math.min(maxH, maxW / targetRatio),
                            );

                            const absDx = Math.abs(dx);
                            const absDy = Math.abs(dy);

                            let boxW = 0;
                            let boxH = 0;
                            if (absDx / targetRatio >= absDy) {
                                boxW = Math.min(absDx, maxW_allowed);
                                boxH = boxW / targetRatio;
                            } else {
                                boxH = Math.min(absDy, maxH_allowed);
                                boxW = boxH * targetRatio;
                            }

                            if (boxW >= MIN_SEL_PX && boxH >= MIN_SEL_PX) {
                                const x0 =
                                    signX > 0
                                        ? drag.startX
                                        : drag.startX - boxW;
                                const y0 =
                                    signY > 0
                                        ? drag.startY
                                        : drag.startY - boxH;
                                state.cropRect = {
                                    x: (x0 - mb.bx) / mb.bw,
                                    y: (y0 - mb.by) / mb.bh,
                                    w: boxW / mb.bw,
                                    h: boxH / mb.bh,
                                };
                            }
                        }
                    } else if (drag.mode === "move" && drag.origRect) {
                        const curW = drag.origRect.w;
                        const curH = drag.origRect.h;
                        const nx = (px - drag.offX - mb.bx) / mb.bw;
                        const ny = (py - drag.offY - mb.by) / mb.bh;
                        state.cropRect = {
                            x: Math.max(0, Math.min(1 - curW, nx)),
                            y: Math.max(0, Math.min(1 - curH, ny)),
                            w: curW,
                            h: curH,
                        };
                    } else if (drag.mode === "resize" && drag.origRect) {
                        const targetRatio = getTargetAspectRatio();
                        const r = drag.origRect;
                        let x0 = mb.bx + r.x * mb.bw;
                        let y0 = mb.by + r.y * mb.bh;
                        let x1 = x0 + r.w * mb.bw;
                        let y1 = y0 + r.h * mb.bh;

                        if (drag.corner.includes("w")) x0 = clampX(px);
                        if (drag.corner.includes("e")) x1 = clampX(px);
                        if (drag.corner.includes("n")) y0 = clampY(py);
                        if (drag.corner.includes("s")) y1 = clampY(py);

                        let nw = Math.max(MIN_SEL_PX, x1 - x0);
                        let nh = Math.max(MIN_SEL_PX, y1 - y0);

                        if (targetRatio) {
                            if (drag.corner === "nw" || drag.corner === "se") {
                                nh = nw / targetRatio;
                            } else {
                                nw = nh * targetRatio;
                            }
                        }

                        state.cropRect = {
                            x: Math.max(0, (x0 - mb.bx) / mb.bw),
                            y: Math.max(0, (y0 - mb.by) / mb.bh),
                            w: Math.min(1, nw / mb.bw),
                            h: Math.min(1, nh / mb.bh),
                        };
                    }

                    node.setDirtyCanvas(true, true);
                    return true;
                }

                return false;
            }

            function handleMouseUp(_e, _pos) {
                if (state.dragTarget === "crop") {
                    if (
                        state.cropDrag?.mode === "new" &&
                        !state.cropDrag.moved
                    ) {
                        // Click outside without dragging clears crop
                        state.cropRect = null;
                    }
                    syncCrop();
                    state.dragTarget = null;
                    state.cropDrag = null;
                    node.setDirtyCanvas(true, true);
                    return true;
                }

                if (state.dragTarget) {
                    state.dragTarget = null;
                    node.setDirtyCanvas(true, true);
                    return true;
                }

                return false;
            }

            // Route mouse events directly on the custom widget for LiteGraph
            customWidget.mouse = function (event, pos, _node) {
                const px =
                    isVueMode() && typeof event?.offsetX === "number"
                        ? event.offsetX
                        : pos[0];
                const py =
                    isVueMode() && typeof event?.offsetY === "number"
                        ? event.offsetY
                        : pos[1];
                if (!isVueMode() && isNodeCorner(px, py, _node || node)) {
                    return false;
                }
                const t = event?.type;

                if (t === "pointerdown" || t === "mousedown") {
                    window.__referenceLoaderActiveNode = node.id;
                    const res = handleMouseDown(event, [px, py]);
                    if (res) {
                        if (isVueMode()) customWidget.triggerDraw?.();
                        return true;
                    }
                } else if (t === "pointermove" || t === "mousemove") {
                    const res = handleMouseMove(event, [px, py]);
                    if (res) {
                        if (isVueMode()) customWidget.triggerDraw?.();
                        return true;
                    }
                } else if (t === "pointerup" || t === "mouseup") {
                    const res = handleMouseUp(event, [px, py]);
                    if (res) {
                        if (isVueMode()) customWidget.triggerDraw?.();
                        return true;
                    }
                }
                return false;
            };

            // Hook node mouse handlers as fallbacks
            // ─── Vue (Nodes 2.0) Help Button & Popup DOM Mirror ───
            function syncVueHelpUI(node, state) {
                if (!isVueMode()) return;
                const nodeEl =
                    document.querySelector(`[data-node-id="${node.id}"]`) ||
                    (customWidget?.element?.closest?.("[data-node-id]"));
                if (!nodeEl) return;

                const isCollapsed = !!(node.flags?.collapsed || nodeEl.dataset.collapsed);

                // 1. Help Button (?)
                let btn = nodeEl.querySelector(":scope > .cui-ref-help-btn");
                if (!btn) {
                    btn = document.createElement("button");
                    btn.type = "button";
                    btn.className = "cui-ref-help-btn";
                    btn.textContent = "?";
                    btn.title = "View Video Loader & Timeline Guide";
                    Object.assign(btn.style, {
                        position: "absolute",
                        top: "6px",
                        right: "8px",
                        width: "18px",
                        height: "18px",
                        borderRadius: "50%",
                        background: "rgba(255, 255, 255, 0.15)",
                        border: "1px solid rgba(255, 255, 255, 0.35)",
                        color: "#ffffff",
                        fontSize: "11px",
                        fontWeight: "bold",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        cursor: "pointer",
                        zIndex: "60",
                        padding: "0",
                        lineHeight: "1",
                        boxSizing: "border-box",
                        transition: "background 0.15s, border-color 0.15s, color 0.15s",
                        userSelect: "none",
                        outline: "none",
                    });

                    btn.addEventListener("mouseenter", () => {
                        btn.style.background = C.accent;
                        btn.style.borderColor = C.accentGlow;
                        btn.style.color = "#000000";
                    });
                    btn.addEventListener("mouseleave", () => {
                        if (!state.helpOpen) {
                            btn.style.background = "rgba(255, 255, 255, 0.15)";
                            btn.style.borderColor = "rgba(255, 255, 255, 0.35)";
                            btn.style.color = "#ffffff";
                        }
                    });

                    btn.addEventListener("pointerdown", (e) => e.stopPropagation());
                    btn.addEventListener("mousedown", (e) => e.stopPropagation());
                    btn.addEventListener("click", (e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        state.helpOpen = !state.helpOpen;
                        syncVueHelpUI(node, state);
                    });

                    nodeEl.appendChild(btn);
                }

                btn.style.display = isCollapsed ? "none" : "flex";
                if (state.helpOpen) {
                    btn.style.background = C.accent;
                    btn.style.borderColor = C.accentGlow;
                    btn.style.color = "#000000";
                } else {
                    btn.style.background = "rgba(255, 255, 255, 0.15)";
                    btn.style.borderColor = "rgba(255, 255, 255, 0.35)";
                    btn.style.color = "#ffffff";
                }

                // 2. Guide Context Window Popup
                let popup = nodeEl.querySelector(":scope > .cui-ref-guide-popup");
                if (!popup) {
                    popup = document.createElement("div");
                    popup.className = "cui-ref-guide-popup";
                    Object.assign(popup.style, {
                        position: "absolute",
                        left: "calc(100% + 12px)",
                        top: "0px",
                        width: "360px",
                        background: "rgba(18, 22, 30, 0.98)",
                        border: `1.5px solid ${C.accent}`,
                        borderRadius: "8px",
                        boxShadow: "0 4px 20px rgba(0, 0, 0, 0.7)",
                        zIndex: "1000",
                        color: "#dbe2ef",
                        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                        fontSize: "11px",
                        lineHeight: "1.4",
                        overflow: "hidden",
                        pointerEvents: "auto",
                        userSelect: "none",
                        boxSizing: "border-box",
                    });

                    popup.addEventListener("pointerdown", (e) => e.stopPropagation());
                    popup.addEventListener("mousedown", (e) => e.stopPropagation());
                    popup.addEventListener("wheel", (e) => e.stopPropagation());

                    popup.innerHTML = `
                        <div style="background: rgba(74, 180, 255, 0.12); border-bottom: 1px solid rgba(74, 180, 255, 0.3); padding: 7px 12px; display: flex; align-items: center; justify-content: space-between;">
                            <span style="font-weight: bold; font-size: 11px; color: #4ab4ff; letter-spacing: 0.5px;">VIDEO LOADER &amp; TIMELINE SHORTCUTS</span>
                            <button type="button" class="cui-ref-popup-close" style="background: none; border: none; color: #94a3b8; font-size: 14px; cursor: pointer; padding: 0 4px; line-height: 1; outline: none;">✕</button>
                        </div>
                        <div style="padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; color: #dbe2ef; font-size: 10.5px;">
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <span style="background: #252932; border: 1px solid #333a46; color: #4ab4ff; padding: 2px 7px; border-radius: 4px; font-weight: bold; font-size: 10px; min-width: 52px; text-align: center;">Space</span>
                                <span>Play / Pause video playback</span>
                            </div>
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <span style="background: #252932; border: 1px solid #333a46; color: #4ab4ff; padding: 2px 7px; border-radius: 4px; font-weight: bold; font-size: 10px; min-width: 52px; text-align: center;">← / → / [ / ]</span>
                                <span>Step backward / forward 1 frame</span>
                            </div>
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <span style="background: #252932; border: 1px solid #333a46; color: #4ab4ff; padding: 2px 7px; border-radius: 4px; font-weight: bold; font-size: 10px; min-width: 52px; text-align: center;">I</span>
                                <span>Set In-point trim start</span>
                            </div>
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <span style="background: #252932; border: 1px solid #333a46; color: #4ab4ff; padding: 2px 7px; border-radius: 4px; font-weight: bold; font-size: 10px; min-width: 52px; text-align: center;">O</span>
                                <span>Set Out-point trim end</span>
                            </div>
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <span style="background: #252932; border: 1px solid #333a46; color: #4ab4ff; padding: 2px 7px; border-radius: 4px; font-weight: bold; font-size: 10px; min-width: 52px; text-align: center;">M</span>
                                <span>Toggle marker on current frame</span>
                            </div>
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <span style="background: #252932; border: 1px solid #333a46; color: #4ab4ff; padding: 2px 7px; border-radius: 4px; font-weight: bold; font-size: 10px; min-width: 52px; text-align: center;">Shift+M</span>
                                <span>Clear all markers</span>
                            </div>
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <span style="background: #252932; border: 1px solid #333a46; color: #4ab4ff; padding: 2px 7px; border-radius: 4px; font-weight: bold; font-size: 10px; min-width: 52px; text-align: center;">U</span>
                                <span>Toggle Mute / Unmute audio</span>
                            </div>
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <span style="background: #252932; border: 1px solid #333a46; color: #4ab4ff; padding: 2px 7px; border-radius: 4px; font-weight: bold; font-size: 10px; min-width: 52px; text-align: center;">C</span>
                                <span>Clear spatial crop back to full frame</span>
                            </div>
                            <div style="border-top: 1px solid rgba(255, 255, 255, 0.08); margin-top: 4px; padding-top: 6px;">
                                <div style="font-weight: bold; color: #8892b0; margin-bottom: 3px; font-size: 10px;">MOUSE CONTROLS:</div>
                                <div style="color: #cad2c5; font-size: 10px;">• Monitor: Drag to crop • Move inside • 8 handles resize</div>
                                <div style="color: #cad2c5; font-size: 10px;">• Timeline: Drag In/Out handles • Click/scrub playhead</div>
                            </div>
                        </div>
                    `;

                    const closeBtn = popup.querySelector(".cui-ref-popup-close");
                    if (closeBtn) {
                        closeBtn.addEventListener("mouseenter", () => closeBtn.style.color = "#ffffff");
                        closeBtn.addEventListener("mouseleave", () => closeBtn.style.color = "#94a3b8");
                        closeBtn.addEventListener("click", (e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            state.helpOpen = false;
                            syncVueHelpUI(node, state);
                        });
                    }

                    nodeEl.appendChild(popup);
                }

                const rect = nodeEl.getBoundingClientRect();
                if (rect.right + 380 > window.innerWidth && rect.left > 380) {
                    popup.style.left = "auto";
                    popup.style.right = "calc(100% + 12px)";
                } else {
                    popup.style.left = "calc(100% + 12px)";
                    popup.style.right = "auto";
                }

                popup.style.display = !isCollapsed && state.helpOpen ? "block" : "none";
            }

            function removeVueHelpUI(node) {
                const nodeEl = document.querySelector(`[data-node-id="${node.id}"]`);
                if (nodeEl) {
                    nodeEl.querySelector(":scope > .cui-ref-help-btn")?.remove();
                    nodeEl.querySelector(":scope > .cui-ref-guide-popup")?.remove();
                }
            }

            // Outside click & Escape handlers
            const onGlobalPointerDown = (e) => {
                if (!state.helpOpen) return;
                if (isVueMode()) {
                    const nodeEl = document.querySelector(`[data-node-id="${node.id}"]`);
                    if (nodeEl) {
                        const btn = nodeEl.querySelector(":scope > .cui-ref-help-btn");
                        const popup = nodeEl.querySelector(":scope > .cui-ref-guide-popup");
                        if (btn?.contains(e.target) || popup?.contains(e.target)) return;
                    }
                    state.helpOpen = false;
                    syncVueHelpUI(node, state);
                    return;
                }

                const canvas = app.canvas?.canvas;
                if (!canvas) return;
                let graphPos = app.canvas.convertEventToGraph?.(e);
                if (!graphPos && app.canvas.ds) {
                    const rect = canvas.getBoundingClientRect();
                    const scale = app.canvas.ds.scale || 1;
                    const offset = app.canvas.ds.offset || [0, 0];
                    graphPos = [(e.clientX - rect.left) / scale - offset[0], (e.clientY - rect.top) / scale - offset[1]];
                }
                if (!graphPos) return;
                const [gx, gy] = graphPos;
                const titleH =
                    (typeof LiteGraph !== "undefined" &&
                        LiteGraph.NODE_TITLE_HEIGHT) ||
                    30;
                const helpCx = node.pos[0] + node.size[0] - 20;
                const helpCy = node.pos[1] - titleH / 2;
                if (Math.hypot(gx - helpCx, gy - helpCy) <= 12) return;

                const popW = 360;
                const popH = 304;
                const popX = node.pos[0] + node.size[0] + 12;
                const popY = node.pos[1] - titleH;
                if (
                    gx >= popX &&
                    gx <= popX + popW &&
                    gy >= popY &&
                    gy <= popY + popH
                ) {
                    const closeX = popX + popW - 16;
                    const closeY = popY + 15;
                    if (Math.hypot(gx - closeX, gy - closeY) <= 12) {
                        state.helpOpen = false;
                        node.setDirtyCanvas(true, true);
                    }
                    return;
                }

                state.helpOpen = false;
                node.setDirtyCanvas(true, true);
            };
            window.addEventListener("pointerdown", onGlobalPointerDown, true);

            const onGlobalKeyDown = (e) => {
                if (e.key === "Escape" && state.helpOpen) {
                    state.helpOpen = false;
                    if (isVueMode()) {
                        syncVueHelpUI(node, state);
                    } else {
                        node.setDirtyCanvas(true, true);
                    }
                }
            };
            window.addEventListener("keydown", onGlobalKeyDown, true);

            // Hook node mouse handlers as fallbacks
            const origOnMouseDown = node.onMouseDown;
            node.onMouseDown = function (e, localPos, graphCanvas) {
                if (!localPos) return origOnMouseDown?.apply(this, arguments);
                if (isNodeCorner(localPos[0], localPos[1], node)) {
                    return origOnMouseDown?.apply(this, arguments);
                }
                const [px, py] = localPos;
                const titleH =
                    (typeof LiteGraph !== "undefined" &&
                        LiteGraph.NODE_TITLE_HEIGHT) ||
                    30;
                const helpCx = node.size[0] - 20;
                const helpCy = -titleH / 2;
                const helpDist = Math.hypot(px - helpCx, py - helpCy);

                if (helpDist <= 12) {
                    state.helpOpen = !state.helpOpen;
                    node.setDirtyCanvas(true, true);
                    return true;
                }

                if (state.helpOpen) {
                    const popW = 360;
                    const popH = 304;
                    const popX = node.size[0] + 12;
                    const popY = -titleH;
                    const closeCx = popX + popW - 16;
                    const closeCy = popY + 15;

                    if (Math.hypot(px - closeCx, py - closeCy) <= 12) {
                        state.helpOpen = false;
                        node.setDirtyCanvas(true, true);
                        return true;
                    }

                    if (
                        px >= popX &&
                        px <= popX + popW &&
                        py >= popY &&
                        py <= popY + popH
                    ) {
                        return true;
                    }

                    state.helpOpen = false;
                    node.setDirtyCanvas(true, true);
                }

                if (handleMouseDown(e, localPos)) return true;
                return origOnMouseDown?.apply(this, arguments);
            };

            const origOnMouseMove = node.onMouseMove;
            node.onMouseMove = function (e, localPos, graphCanvas) {
                if (!localPos) return origOnMouseMove?.apply(this, arguments);
                const [px, py] = localPos;

                // Check ? Help icon hover on title bar
                const titleH =
                    (typeof LiteGraph !== "undefined" &&
                        LiteGraph.NODE_TITLE_HEIGHT) ||
                    30;
                const helpCx = node.size[0] - 20;
                const helpCy = -titleH / 2;
                const helpDist = Math.hypot(px - helpCx, py - helpCy);
                const isHelpHover = helpDist <= 12;

                let isCloseHover = false;
                if (state.helpOpen) {
                    const popW = 360;
                    const popX = node.size[0] + 12;
                    const popY = -titleH;
                    const closeCx = popX + popW - 16;
                    const closeCy = popY + 15;
                    isCloseHover = Math.hypot(px - closeCx, py - closeCy) <= 12;
                }

                if (
                    isHelpHover !== state.helpBadgeHovered ||
                    isCloseHover !== state.closeHovered
                ) {
                    state.helpBadgeHovered = isHelpHover;
                    state.helpHovered = isHelpHover;
                    state.closeHovered = isCloseHover;
                    node.setDirtyCanvas(true, true);
                }

                const canvasEl = graphCanvas?.canvas || app.canvas?.canvas;
                if (canvasEl && (isHelpHover || isCloseHover)) {
                    canvasEl.style.cursor = "pointer";
                }

                if (handleMouseMove(e, localPos)) return true;
                return origOnMouseMove?.apply(this, arguments);
            };

            const origOnMouseUp = node.onMouseUp;
            node.onMouseUp = function (e, localPos) {
                if (handleMouseUp(e, localPos)) return true;
                return origOnMouseUp?.apply(this, arguments);
            };

            // Global mouseup / pointerup listener to ensure drag states never stick
            const onGlobalPointerUp = () => {
                if (state.dragTarget) {
                    if (state.dragTarget === "crop") {
                        if (
                            state.cropDrag?.mode === "new" &&
                            !state.cropDrag.moved
                        ) {
                            state.cropRect = null;
                        }
                        syncCrop();
                        state.cropDrag = null;
                    }
                    state.dragTarget = null;
                    node.setDirtyCanvas(true, true);
                }
            };
            window.addEventListener("pointerup", onGlobalPointerUp);
            window.addEventListener("mouseup", onGlobalPointerUp);

            // Draw Help Button & Floating Shortcut Guide Popup
            function drawHelpBadgeAndPopup(ctx, node, isBadgeHover, isOpen) {
                const titleH =
                    (typeof LiteGraph !== "undefined" &&
                        LiteGraph.NODE_TITLE_HEIGHT) ||
                    30;
                const cx = node.size[0] - 20;
                const cy = -titleH / 2;
                const r = 8;
                const isBadgeActive = isBadgeHover || isOpen;

                ctx.save();
                ctx.beginPath();
                ctx.arc(cx, cy, r, 0, Math.PI * 2);
                ctx.fillStyle = isBadgeActive
                    ? C.accent
                    : "rgba(255, 255, 255, 0.15)";
                ctx.fill();
                ctx.strokeStyle = isBadgeActive
                    ? C.accentGlow
                    : "rgba(255, 255, 255, 0.35)";
                ctx.lineWidth = 1;
                ctx.stroke();

                ctx.fillStyle = isBadgeActive ? "#000" : "#fff";
                ctx.font = "bold 10px sans-serif";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText("?", cx, cy);

                if (isOpen) {
                    const popW = 360;
                    const popH = 304;
                    const popX = node.size[0] + 12;
                    const popY = -titleH;

                    // Shadow / Glow
                    ctx.shadowColor = "rgba(0, 0, 0, 0.7)";
                    ctx.shadowBlur = 16;
                    ctx.shadowOffsetY = 4;

                    drawRoundRect(ctx, popX, popY, popW, popH, 8);
                    ctx.fillStyle = "rgba(18, 22, 30, 0.98)";
                    ctx.fill();
                    ctx.shadowBlur = 0;
                    ctx.shadowOffsetY = 0;

                    ctx.strokeStyle = C.accent;
                    ctx.lineWidth = 1.5;
                    ctx.stroke();

                    // Header bar
                    ctx.fillStyle = "rgba(74, 180, 255, 0.12)";
                    ctx.fillRect(popX + 1, popY + 1, popW - 2, 28);
                    ctx.strokeStyle = "rgba(74, 180, 255, 0.3)";
                    ctx.beginPath();
                    ctx.moveTo(popX + 1, popY + 29);
                    ctx.lineTo(popX + popW - 1, popY + 29);
                    ctx.stroke();

                    ctx.fillStyle = C.accent;
                    ctx.font = "bold 11px sans-serif";
                    ctx.textAlign = "left";
                    ctx.fillText(
                        "VIDEO LOADER & TIMELINE SHORTCUTS",
                        popX + 10,
                        popY + 18,
                    );

                    // Close "✕" Button
                    const closeCx = popX + popW - 16;
                    const closeCy = popY + 15;
                    ctx.fillStyle = state.closeHovered ? "#ffffff" : "#94a3b8";
                    ctx.font = "bold 12px sans-serif";
                    ctx.textAlign = "center";
                    ctx.fillText("✕", closeCx, closeCy);

                    // Shortcut rows
                    const shortcuts = [
                        { key: "Space", desc: "Play / Pause video playback" },
                        {
                            key: "← / →  or  [ / ]",
                            desc: "Step backward / forward 1 frame",
                        },
                        { key: "I", desc: "Set In-point trim start" },
                        { key: "O", desc: "Set Out-point trim end" },
                        { key: "M", desc: "Toggle marker on current frame" },
                        { key: "Shift + M", desc: "Clear all markers" },
                        { key: "U", desc: "Toggle Mute / Unmute audio" },
                        {
                            key: "C",
                            desc: "Clear spatial crop back to full frame",
                        },
                    ];

                    let curY = popY + 46;
                    ctx.font = "10px sans-serif";
                    shortcuts.forEach(({ key, desc }) => {
                        const kw = ctx.measureText(key).width + 12;
                        drawRoundRect(ctx, popX + 10, curY - 10, kw, 16, 3);
                        ctx.fillStyle = "#252932";
                        ctx.fill();
                        ctx.strokeStyle = C.border;
                        ctx.stroke();

                        ctx.fillStyle = C.accent;
                        ctx.textAlign = "center";
                        ctx.fillText(key, popX + 10 + kw / 2, curY + 1);

                        ctx.fillStyle = C.text;
                        ctx.textAlign = "left";
                        ctx.fillText(desc, popX + 10 + kw + 10, curY + 1);

                        curY += 22;
                    });

                    // Mouse Controls Section
                    curY += 6;
                    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
                    ctx.beginPath();
                    ctx.moveTo(popX + 10, curY);
                    ctx.lineTo(popX + popW - 10, curY);
                    ctx.stroke();
                    curY += 16;

                    ctx.fillStyle = C.textDim;
                    ctx.font = "bold 10px sans-serif";
                    ctx.fillText("MOUSE CONTROLS:", popX + 10, curY);
                    curY += 16;

                    ctx.font = "10px sans-serif";
                    ctx.fillStyle = C.text;
                    ctx.fillText(
                        "• Monitor: Drag to crop • Move inside • 8 handles resize",
                        popX + 10,
                        curY,
                    );
                    curY += 16;
                    ctx.fillText(
                        "• Timeline: Drag In/Out handles • Click/scrub playhead",
                        popX + 10,
                        curY,
                    );
                }
                ctx.restore();
            }

            // Draw Help Icon on Foreground
            const origOnDrawForeground = node.onDrawForeground;
            node.onDrawForeground = function (ctx) {
                const ret = origOnDrawForeground?.apply(this, arguments);
                drawHelpBadgeAndPopup(
                    ctx,
                    node,
                    state.helpBadgeHovered,
                    state.helpOpen,
                );
                return ret;
            };

            // Cleanup listener on removal
            const origOnRemoved = node.onRemoved;
            node.onRemoved = function () {
                window.removeEventListener("keydown", onKeyDown, {
                    capture: true,
                });
                window.removeEventListener("pointerup", onGlobalPointerUp);
                window.removeEventListener("mouseup", onGlobalPointerUp);
                window.removeEventListener("pointerdown", onGlobalPointerDown, true);
                window.removeEventListener("keydown", onGlobalKeyDown, true);
                removeVueHelpUI(node);
                state.thumbSeq++;
                state.isGeneratingThumbs = false;
                state.isPlaying = false;
                if (state.videoEl) {
                    try {
                        state.videoEl.pause();
                        state.videoEl.removeAttribute("src");
                        state.videoEl.load();
                    } catch {}
                }
                return origOnRemoved?.apply(this, arguments);
            };

            // Enforce minimum node dimensions smoothly on resize
            const origOnResize = node.onResize;
            node.onResize = function (size) {
                if (size) {
                    size[0] = Math.max(size[0], MIN_NODE_WIDTH);
                    size[1] = Math.max(size[1], MIN_NODE_HEIGHT);
                }
                return origOnResize?.apply(this, arguments);
            };

            // Ensure any setDirtyCanvas triggers Vue widget redraw when in Vue mode
            const origSetDirtyCanvas = node.setDirtyCanvas;
            let inTriggerDraw = false;
            node.setDirtyCanvas = function () {
                const r = origSetDirtyCanvas?.apply(this, arguments);
                if (isVueMode() && !inTriggerDraw) {
                    inTriggerDraw = true;
                    try {
                        customWidget.triggerDraw?.();
                    } finally {
                        inTriggerDraw = false;
                    }
                }
                return r;
            };

            // Register custom widget into node widget list
            node.addCustomWidget(customWidget);

            // Set a generous default size for the node layout
            if (
                !node.size ||
                node.size[0] < MIN_NODE_WIDTH ||
                node.size[1] < MIN_NODE_HEIGHT
            ) {
                node.size = [MIN_NODE_WIDTH, MIN_NODE_HEIGHT];
            }

            return result;
        };
    },
});
