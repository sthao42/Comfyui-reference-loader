import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const MARGIN = 10;
const HANDLE_RADIUS = 7;
const WIDGET_HEIGHT = 160;
const HEADER_H = 22;
const MIN_NODE_WIDTH = 380;
const MIN_NODE_HEIGHT = 240;
const RESIZE_CORNER_SIZE = 20;

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
    waveBody: "rgba(74, 180, 255, 0.75)",
    waveDim: "rgba(255, 255, 255, 0.18)",
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

let sharedAudioCtx = null;
function getAudioContext() {
    if (!sharedAudioCtx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
            sharedAudioCtx = new AudioCtx();
        }
    }
    if (sharedAudioCtx && sharedAudioCtx.state === "suspended") {
        sharedAudioCtx.resume().catch(() => {});
    }
    return sharedAudioCtx;
}

function formatTimecode(seconds) {
    if (
        typeof seconds !== "number" ||
        !Number.isFinite(seconds) ||
        seconds < 0
    ) {
        return "00:00.0";
    }
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    const wholeSecs = Math.floor(secs);
    const tenths = Math.floor((secs - wholeSecs) * 10);
    const mm = mins < 10 ? `0${mins}` : `${mins}`;
    const ss = wholeSecs < 10 ? `0${wholeSecs}` : `${wholeSecs}`;
    return `${mm}:${ss}.${tenths}`;
}

function formatDurationSec(seconds) {
    if (
        typeof seconds !== "number" ||
        !Number.isFinite(seconds) ||
        seconds < 0
    ) {
        return "0.00s";
    }
    return `${seconds.toFixed(2)}s`;
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

function parseAudioValue(value) {
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

function computePeaks(audioBuffer, numBuckets = 180) {
    const rawData = audioBuffer.getChannelData(0);
    const length = rawData.length;
    if (!length || numBuckets <= 0) return new Float32Array(0);
    const bucketSize = Math.max(1, Math.floor(length / numBuckets));
    const step = Math.max(1, Math.floor(bucketSize / 300));
    const peaks = new Float32Array(numBuckets);

    for (let i = 0; i < numBuckets; i++) {
        const start = i * bucketSize;
        const end = Math.min(start + bucketSize, length);
        let max = 0;
        for (let j = start; j < end; j += step) {
            const val = Math.abs(rawData[j]);
            if (val > max) max = val;
        }
        peaks[i] = max;
    }
    return peaks;
}

app.registerExtension({
    name: "reference_loader.load_audio_crop",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "LoadAudioCrop") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            const node = this;
            node.resizable = true;

            const isVueMode = () =>
                typeof LiteGraph !== "undefined" && !!LiteGraph.vueNodesMode;

            // Suppress default background preview canvas
            node.onDrawBackground = function (_ctx) {};

            const audioWidget = node.widgets?.find((w) => w.name === "audio");
            const startWidget = node.widgets?.find(
                (w) => w.name === "start_time",
            );
            const endWidget = node.widgets?.find((w) => w.name === "end_time");

            // Hide stock audioUI widget
            const audioUIWidget = node.widgets?.find(
                (w) => w.name === "audioUI",
            );
            if (audioUIWidget) {
                audioUIWidget.hidden = true;
                audioUIWidget.options = audioUIWidget.options || {};
                audioUIWidget.options.hidden = true;
                if (audioUIWidget.element) {
                    audioUIWidget.element.style.display = "none";
                    if (
                        audioUIWidget.element.parentElement &&
                        audioUIWidget.element.parentElement !== node.element
                    ) {
                        audioUIWidget.element.parentElement.style.display =
                            "none";
                    }
                }
                audioUIWidget.computeSize = () => [0, -4];
            }

            const state = {
                audioBuffer: null,
                peaks: null,
                duration: 0,
                loading: false,
                error: null,
                isPlaying: false,
                isLooping: true,
                sourceNode: null,
                playbackStartCtxTime: 0,
                playbackOffsetSec: 0,
                seekerCurrentTime: 0, // playhead seeker position in seconds
                animId: null,
                drag: null, // { mode: "seeker" | "start" | "end" | "move", ... }
                seekerBox: null, // { bx, by, bw, bh } for seeker waveform area
                lastLoadedUrl: null,
                hoverBtn: null,
                transportBtns: [],
                helpHovered: false,
            };

            function getCropTimes() {
                const total = state.duration || 0;
                let s = Math.max(
                    0,
                    Math.round(Number(startWidget?.value) || 0),
                );
                let e = Math.round(Number(endWidget?.value) || 0);
                if (e <= 0 || e > total) {
                    e = total;
                }
                if (s > e) s = 0;
                const isCropped =
                    s > 0 || (e > 0 && Math.abs(e - total) >= 0.5);
                return { start: s, end: e, isCropped };
            }

            function setCropTimes(start, end) {
                const total = state.duration || 0;
                let s = Math.max(0, Math.min(total, Math.round(start)));
                let e = Math.max(0, Math.min(total, Math.round(end)));
                if (s > e) {
                    const tmp = s;
                    s = e;
                    e = tmp;
                }
                if (
                    s <= 0 &&
                    (total <= 0 ||
                        e <= 0 ||
                        (total > 0 && Math.abs(e - Math.round(total)) <= 0))
                ) {
                    s = 0;
                    e = 0;
                }
                if (startWidget) startWidget.value = s;
                if (endWidget) endWidget.value = e;
                node.setDirtyCanvas(true, true);
            }

            function stopAudio(resetSeeker = false) {
                if (state.sourceNode) {
                    try {
                        state.sourceNode.onended = null;
                        state.sourceNode.stop();
                        state.sourceNode.disconnect();
                    } catch (e) {}
                    state.sourceNode = null;
                }
                state.isPlaying = false;
                if (state.animId) {
                    cancelAnimationFrame(state.animId);
                    state.animId = null;
                }
                if (resetSeeker) {
                    const { start } = getCropTimes();
                    state.seekerCurrentTime = start;
                }
                node.setDirtyCanvas(true, true);
            }

            function playAudio() {
                if (!state.audioBuffer) return;
                stopAudio(false);

                const ctx = getAudioContext();
                if (!ctx) return;

                const totalDur = state.duration || 0;
                const { start, end, isCropped } = getCropTimes();
                const sectionStart = isCropped ? start : 0;
                const sectionEnd = isCropped ? end : totalDur;

                let playStart = state.seekerCurrentTime;
                if (
                    playStart < sectionStart ||
                    playStart >= sectionEnd - 0.05
                ) {
                    playStart = sectionStart;
                }
                const playDuration = Math.max(0.05, sectionEnd - playStart);

                const source = ctx.createBufferSource();
                source.buffer = state.audioBuffer;
                source.connect(ctx.destination);

                state.sourceNode = source;
                state.isPlaying = true;
                state.playbackStartCtxTime = ctx.currentTime;
                state.playbackOffsetSec = playStart;
                state.seekerCurrentTime = playStart;

                source.onended = () => {
                    if (state.sourceNode === source) {
                        state.sourceNode = null;
                        if (state.animId) {
                            cancelAnimationFrame(state.animId);
                            state.animId = null;
                        }
                        if (state.isLooping && state.isPlaying) {
                            state.seekerCurrentTime = sectionStart;
                            playAudio();
                        } else {
                            state.isPlaying = false;
                            state.seekerCurrentTime = sectionStart;
                            node.setDirtyCanvas(true, true);
                        }
                    }
                };

                source.start(0, playStart, playDuration);

                function loop() {
                    if (state.isPlaying && sharedAudioCtx) {
                        // Pause if tab/graph switched away
                        if (
                            !node.graph ||
                            (typeof app !== "undefined" &&
                                app.graph &&
                                node.graph !== app.graph)
                        ) {
                            stopAudio(false);
                            return;
                        }
                        const elapsed =
                            sharedAudioCtx.currentTime -
                            state.playbackStartCtxTime;
                        const current = state.playbackOffsetSec + elapsed;
                        state.seekerCurrentTime = Math.min(sectionEnd, current);
                        node.setDirtyCanvas(true, true);
                        if (state.isPlaying) {
                            state.animId = requestAnimationFrame(loop);
                        }
                    }
                }
                state.animId = requestAnimationFrame(loop);
            }

            let loadSeq = 0;
            async function loadAudioFile(forceRefresh = false) {
                stopAudio();
                const seq = ++loadSeq;
                const info = parseAudioValue(audioWidget?.value);
                if (!info) {
                    state.audioBuffer = null;
                    state.peaks = null;
                    state.duration = 0;
                    state.loading = false;
                    state.error = null;
                    state.lastLoadedUrl = null;
                    state.seekerCurrentTime = 0;
                    node.setDirtyCanvas(true, true);
                    return;
                }

                if (info) info.type = clampViewType(info.type);
                if (
                    !info ||
                    !isSafeViewPath(info.filename) ||
                    !isSafeViewPath(info.subfolder)
                ) {
                    console.error(
                        "[reference-loader] unsafe /view path, skipping:",
                        info?.filename,
                        info?.subfolder,
                    );
                    state.audioBuffer = null;
                    state.peaks = null;
                    state.duration = 0;
                    state.loading = false;
                    state.error = "Unsafe file path";
                    state.lastLoadedUrl = null;
                    node.setDirtyCanvas(true, true);
                    return;
                }
                const baseUrl = api.apiURL(
                    `/view?filename=${encodeURIComponent(info.filename)}` +
                        `&type=${info.type}&subfolder=${encodeURIComponent(info.subfolder)}`,
                );
                const url = forceRefresh
                    ? `${baseUrl}&rand=${Date.now()}`
                    : baseUrl;

                if (
                    !forceRefresh &&
                    state.lastLoadedUrl === baseUrl
                ) {
                    node.setDirtyCanvas(true, true);
                    return;
                }

                state.loading = true;
                state.error = null;
                state.lastLoadedUrl = baseUrl;
                node.setDirtyCanvas(true, true);

                try {
                    const res = await fetch(url);
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const arrayBuffer = await res.arrayBuffer();
                    if (seq !== loadSeq) return;

                    const ctx = getAudioContext();
                    if (!ctx) throw new Error("Web Audio API not supported");

                    const decoded = await ctx.decodeAudioData(
                        arrayBuffer.slice(0),
                    );
                    if (seq !== loadSeq) return;

                    state.audioBuffer = decoded;
                    state.duration = decoded.duration;
                    state.peaks = computePeaks(decoded, 200);
                    state.loading = false;
                    state.error = null;
                    state.seekerCurrentTime = Math.max(
                        0,
                        Number(startWidget?.value) || 0,
                    );
                    node.setDirtyCanvas(true, true);
                } catch (err) {
                    if (seq !== loadSeq) return;
                    state.audioBuffer = null;
                    state.peaks = null;
                    state.duration = 0;
                    state.loading = false;
                    state.error = "Could not decode audio";
                    state.seekerCurrentTime = 0;
                    node.setDirtyCanvas(true, true);
                }
            }

            // Sync audio widget
            let lastAudioVal = audioWidget?.value;
            if (audioWidget) {
                let internalVal = audioWidget.value;
                const valProp = Object.getOwnPropertyDescriptor(
                    audioWidget,
                    "value",
                );
                Object.defineProperty(audioWidget, "value", {
                    get() {
                        return valProp && valProp.get
                            ? valProp.get.call(audioWidget)
                            : internalVal;
                    },
                    set(v) {
                        if (valProp && valProp.set) {
                            valProp.set.call(audioWidget, v);
                        } else {
                            internalVal = v;
                        }
                        if (
                            audioWidget.options?.values &&
                            !audioWidget.options.values.includes(v)
                        ) {
                            audioWidget.options.values.push(v);
                        }
                        if (v !== lastAudioVal) {
                            lastAudioVal = v;
                            loadAudioFile();
                        }
                    },
                    configurable: true,
                    enumerable: true,
                });

                const origCb = audioWidget.callback;
                audioWidget.callback = function (v) {
                    const cur = v !== undefined ? v : audioWidget.value;
                    if (cur !== lastAudioVal) {
                        lastAudioVal = cur;
                        loadAudioFile();
                    }
                    origCb?.apply(this, arguments);
                };
            }

            if (audioWidget?.value) {
                lastAudioVal = audioWidget.value;
                loadAudioFile();
            }

            const origOnConfigure = node.onConfigure;
            node.onConfigure = function () {
                node._was_configured = true;
                const ret = origOnConfigure?.apply(this, arguments);
                if (startWidget) {
                    state.seekerCurrentTime = Math.max(
                        0,
                        Number(startWidget.value) || 0,
                    );
                }
                if (audioWidget?.value) {
                    lastAudioVal = audioWidget.value;
                    loadAudioFile(false);
                }
                return ret;
            };

            function calcAudioTransportLayout(w) {
                const btnH = 22;
                const gapX = 4;
                const gapY = 4;
                const pad = 4;
                const maxW = Math.max(60, w - pad * 2);

                const btns = [
                    { id: "stepBack", label: "⏮", tip: "Step -1s", w: 26 },
                    {
                        id: "play",
                        label: state.isPlaying ? "⏸" : "▶",
                        tip: "Play / Pause (Space)",
                        active: state.isPlaying,
                        w: 26,
                    },
                    { id: "stop", label: "■", tip: "Stop", w: 26 },
                    { id: "stepFwd", label: "⏭", tip: "Step +1s", w: 26 },
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
                        id: "loop",
                        label: "🔁",
                        tip: "Loop Playback",
                        active: state.isLooping,
                        w: 26,
                    },
                    {
                        id: "reset",
                        label: "✕ Full",
                        tip: "Reset to Full Track",
                        w: 46,
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

            const waveformWidget = {
                name: "audio_seeker_player",
                type: "reference_loader_audioseeker",
                value: "",
                serialize: false,
                options: { serialize: false },

                computeSize: function (width) {
                    return [
                        Math.max(width || 0, MIN_NODE_WIDTH),
                        WIDGET_HEIGHT,
                    ];
                },

                computeLayoutSize: function (_n) {
                    if (isVueMode()) {
                        const w = state.lastDrawW || (_n?.size?.[0] ?? MIN_NODE_WIDTH);
                        const transW = Math.max(20, w - MARGIN * 2 - 12);
                        const transportLayout = calcAudioTransportLayout(transW);
                        const infoH = state.duration > 0 ? 18 : 0;
                        const h = HEADER_H + 6 + 36 + (infoH > 0 ? infoH + 4 : 0) + transportLayout.totalH + 24;
                        return { minHeight: h, maxHeight: h, minWidth: 0 };
                    }
                    return {
                        minHeight: WIDGET_HEIGHT,
                        maxHeight: 1000,
                        minWidth: MIN_NODE_WIDTH,
                    };
                },

                draw: function (ctx, _node, widgetWidth, y, H, lowQuality) {
                    const effWidth = _node?.size?.[0]
                        ? Math.min(widgetWidth, _node.size[0])
                        : widgetWidth;
                    state.lastDrawW = effWidth;
                    const w = Math.max(20, effWidth - MARGIN * 2);
                    const x = MARGIN;
                    const actualH = isVueMode() ? (this.computedHeight ?? H) : (this.computedHeight ?? H);
                    const h = Math.max(130, actualH - 6);

                    ctx.save();

                    // Background panel
                    drawRoundRect(ctx, x, y, w, h, 6);
                    ctx.fillStyle = C.bg;
                    ctx.fill();
                    ctx.strokeStyle = C.border;
                    ctx.lineWidth = 1;
                    ctx.stroke();

                    // Top header bar
                    const headerH = HEADER_H;
                    ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
                    ctx.fillRect(x + 1, y + 1, w - 2, headerH);
                    ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
                    ctx.beginPath();
                    ctx.moveTo(x + 1, y + headerH + 1);
                    ctx.lineTo(x + w - 1, y + headerH + 1);
                    ctx.stroke();

                    ctx.font = "10px sans-serif";
                    ctx.textAlign = "left";
                    ctx.fillStyle = C.textDim;
                    ctx.fillText("AUDIO WAVEFORM TRACK", x + 8, y + 15);

                    // Time and range status
                    const totalDur = state.duration || 0;
                    const currSeekerTime = Math.max(
                        0,
                        Math.min(totalDur, state.seekerCurrentTime),
                    );
                    const timeStr =
                        totalDur > 0
                            ? `${formatTimecode(currSeekerTime)} / ${formatTimecode(totalDur)} (${formatDurationSec(totalDur)})`
                            : "";
                    const { start, end, isCropped } = getCropTimes();
                    const cropDur = isCropped
                        ? Math.max(0, Math.round(end - start))
                        : Math.round(totalDur);
                    const rangeStr = isCropped
                        ? `Range: ${start}s..${end}s (${cropDur}s)`
                        : "";
                    const fullInfoStr =
                        totalDur > 0
                            ? isCropped
                                ? `${timeStr}  •  ${rangeStr}`
                                : timeStr
                            : "";
                    const infoH = fullInfoStr ? 18 : 0;

                    // Transport toolbar layout
                    const transW = Math.max(20, w - 12);
                    const transportLayout = calcAudioTransportLayout(transW);
                    const transportH = transportLayout.totalH;

                    // Waveform track
                    const seekerX = x + 6;
                    const seekerY = y + headerH + 6;
                    const seekerW = Math.max(10, w - 12);
                    const seekerH = Math.max(
                        36,
                        h -
                            headerH -
                            (infoH > 0 ? infoH + 4 : 0) -
                            transportH -
                            18,
                    );
                    state.seekerBox = {
                        bx: seekerX,
                        by: seekerY,
                        bw: seekerW,
                        bh: seekerH,
                    };

                    ctx.fillStyle = "#11141a";
                    drawRoundRect(ctx, seekerX, seekerY, seekerW, seekerH, 4);
                    ctx.fill();
                    ctx.strokeStyle = C.border;
                    ctx.stroke();

                    // Loading / Error / Empty States
                    if (state.loading) {
                        ctx.fillStyle = C.textDim;
                        ctx.font = "11px sans-serif";
                        ctx.textAlign = "center";
                        ctx.textBaseline = "middle";
                        ctx.fillText(
                            "Loading audio waveform...",
                            seekerX + seekerW / 2,
                            seekerY + seekerH / 2,
                        );
                    } else if (
                        state.error ||
                        !state.peaks ||
                        state.duration <= 0
                    ) {
                        ctx.fillStyle = state.error ? "#f87171" : C.textDim;
                        ctx.font = "11px sans-serif";
                        ctx.textAlign = "center";
                        ctx.textBaseline = "middle";
                        ctx.fillText(
                            state.error ||
                                "No audio loaded (select or upload an audio file)",
                            seekerX + seekerW / 2,
                            seekerY + seekerH / 2,
                        );
                    } else {
                        const normStart = totalDur > 0 ? start / totalDur : 0;
                        const normEnd = totalDur > 0 ? end / totalDur : 1;
                        const cropPxStart = seekerX + normStart * seekerW;
                        const cropPxEnd = seekerX + normEnd * seekerW;

                        // Waveform Bars
                        if (
                            state.peaks &&
                            state.peaks.length > 0 &&
                            !lowQuality
                        ) {
                            ctx.save();
                            ctx.beginPath();
                            drawRoundRect(
                                ctx,
                                seekerX,
                                seekerY,
                                seekerW,
                                seekerH,
                                4,
                            );
                            ctx.clip();

                            const peaks = state.peaks;
                            const numBars = peaks.length;
                            const step = seekerW / numBars;
                            const barWidth = Math.max(1, step - 0.5);
                            const centerY = seekerY + seekerH / 2;

                            for (let i = 0; i < numBars; i++) {
                                const bx = seekerX + i * step;
                                const amp = peaks[i];
                                const barH = Math.max(
                                    2,
                                    amp * Math.max(4, seekerH - 8),
                                );
                                const inCrop =
                                    !isCropped ||
                                    (bx + barWidth >= cropPxStart &&
                                        bx <= cropPxEnd);

                                ctx.fillStyle = inCrop ? C.waveBody : C.waveDim;
                                drawRoundRect(
                                    ctx,
                                    bx,
                                    centerY - barH / 2,
                                    barWidth,
                                    barH,
                                    1,
                                );
                                ctx.fill();
                            }
                            ctx.restore();
                        }

                        // In/Out Shading & Handles
                        if (isCropped && !lowQuality) {
                            ctx.save();
                            ctx.beginPath();
                            drawRoundRect(
                                ctx,
                                seekerX,
                                seekerY,
                                seekerW,
                                seekerH,
                                4,
                            );
                            ctx.clip();

                            if (cropPxStart > seekerX) {
                                ctx.fillStyle = C.inOutShade;
                                ctx.fillRect(
                                    seekerX,
                                    seekerY,
                                    cropPxStart - seekerX,
                                    seekerH,
                                );
                            }
                            if (cropPxEnd < seekerX + seekerW) {
                                ctx.fillStyle = C.inOutShade;
                                ctx.fillRect(
                                    cropPxEnd,
                                    seekerY,
                                    seekerX + seekerW - cropPxEnd,
                                    seekerH,
                                );
                            }
                            ctx.restore();

                            // In/Out Boundary Lines
                            ctx.strokeStyle = C.inOutHandle;
                            ctx.lineWidth = 1.5;
                            ctx.beginPath();
                            ctx.moveTo(cropPxStart, seekerY);
                            ctx.lineTo(cropPxStart, seekerY + seekerH);
                            ctx.moveTo(cropPxEnd, seekerY);
                            ctx.lineTo(cropPxEnd, seekerY + seekerH);
                            ctx.stroke();

                            // Start & End Handle Pins
                            const drawPin = (hx) => {
                                ctx.fillStyle = C.inOutHandle;
                                ctx.beginPath();
                                ctx.arc(
                                    hx,
                                    seekerY + seekerH / 2,
                                    HANDLE_RADIUS,
                                    0,
                                    Math.PI * 2,
                                );
                                ctx.fill();
                                ctx.strokeStyle = "#ffffff";
                                ctx.lineWidth = 1.5;
                                ctx.stroke();

                                ctx.fillStyle = "#0f172a";
                                ctx.beginPath();
                                ctx.arc(
                                    hx,
                                    seekerY + seekerH / 2,
                                    2.5,
                                    0,
                                    Math.PI * 2,
                                );
                                ctx.fill();
                            };
                            drawPin(cropPxStart);
                            drawPin(cropPxEnd);
                        }

                        // Playhead Needle & Diamond Top (Matches load_video_crop)
                        const playheadPx =
                            seekerX + (currSeekerTime / totalDur) * seekerW;

                        ctx.fillStyle = C.playhead;
                        ctx.beginPath();
                        ctx.moveTo(playheadPx - 5, seekerY);
                        ctx.lineTo(playheadPx + 5, seekerY);
                        ctx.lineTo(playheadPx, seekerY + 6);
                        ctx.closePath();
                        ctx.fill();

                        ctx.strokeStyle = C.playhead;
                        ctx.lineWidth = 1.5;
                        ctx.beginPath();
                        ctx.moveTo(playheadPx, seekerY + 5);
                        ctx.lineTo(playheadPx, seekerY + seekerH);
                        ctx.stroke();
                    }

                    // 4. Dedicated Information Text Line Element (under timeline)
                    const infoX = x + 6;
                    const infoY = seekerY + seekerH + 4;
                    if (infoH > 0) {
                        drawRoundRect(ctx, infoX, infoY, transW, infoH, 3);
                        ctx.fillStyle = "rgba(21, 24, 30, 0.75)";
                        ctx.fill();
                        ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
                        ctx.lineWidth = 1;
                        ctx.stroke();

                        ctx.font = "10px monospace";
                        ctx.textAlign = "right";
                        ctx.textBaseline = "middle";
                        ctx.fillStyle = C.accent;
                        ctx.fillText(
                            fullInfoStr,
                            infoX + transW - 8,
                            infoY + infoH / 2,
                        );
                    }

                    // 5. Transport Bar (Bottom Toolbar, pure buttons UI)
                    const transX = x + 6;
                    const transY = y + h - transportH - 6;

                    drawRoundRect(ctx, transX, transY, transW, transportH, 4);
                    ctx.fillStyle = C.panelBg;
                    ctx.fill();
                    ctx.strokeStyle = C.border;
                    ctx.stroke();

                    ctx.font = "11px sans-serif";
                    ctx.textAlign = "center";
                    ctx.textBaseline = "middle";

                    const stateBtns = [];
                    for (const btn of transportLayout.layoutBtns) {
                        const bx = transX + btn.relX;
                        const by = transY + btn.relY;
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

                    ctx.restore();
                },

                mouse: function (event, pos, _node) {
                    if (
                        !state.audioBuffer ||
                        state.duration <= 0 ||
                        !state.seekerBox
                    )
                        return false;
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
                    const t = event.type;
                    const { bx, by, bw, bh } = state.seekerBox;
                    const totalDur = state.duration;

                    const clampX = (v) => Math.max(bx, Math.min(bx + bw, v));
                    const pxToTime = (xCoord) => {
                        const norm = Math.max(
                            0,
                            Math.min(1, (xCoord - bx) / bw),
                        );
                        return norm * totalDur;
                    };

                    const { start, end, isCropped } = getCropTimes();
                    const normStart = totalDur > 0 ? start / totalDur : 0;
                    const normEnd = totalDur > 0 ? end / totalDur : 1;
                    const cropPxStart = bx + normStart * bw;
                    const cropPxEnd = bx + normEnd * bw;
                    const handleHitRadius = HANDLE_RADIUS + 4;

                    // Check Transport Buttons Hit
                    if (t === "pointerdown" || t === "mousedown") {
                        window.__referenceLoaderActiveNode = node.id;
                        node.is_selected = true;
                        if (typeof app !== "undefined" && app.canvas) {
                            if (typeof app.canvas.selectNode === "function")
                                app.canvas.selectNode(node);
                            app.canvas.current_node = node;
                        }

                        if (state.transportBtns) {
                            for (const btn of state.transportBtns) {
                                if (
                                    px >= btn.rect.x &&
                                    px <= btn.rect.x + btn.rect.w &&
                                    py >= btn.rect.y &&
                                    py <= btn.rect.y + btn.rect.h
                                ) {
                                    if (btn.id === "play") {
                                        if (state.isPlaying) stopAudio(false);
                                        else playAudio();
                                    } else if (btn.id === "stop") {
                                        stopAudio(true);
                                    } else if (btn.id === "stepBack") {
                                        state.seekerCurrentTime = Math.max(
                                            0,
                                            state.seekerCurrentTime - 1.0,
                                        );
                                        if (state.isPlaying) playAudio();
                                    } else if (btn.id === "stepFwd") {
                                        state.seekerCurrentTime = Math.min(
                                            totalDur,
                                            state.seekerCurrentTime + 1.0,
                                        );
                                        if (state.isPlaying) playAudio();
                                    } else if (btn.id === "setIn") {
                                        const cur = Math.round(
                                            state.seekerCurrentTime,
                                        );
                                        const curEnd = Math.round(
                                            end > 0 ? end : totalDur,
                                        );
                                        setCropTimes(
                                            cur,
                                            Math.max(cur + 1, curEnd),
                                        );
                                        if (state.isPlaying) playAudio();
                                    } else if (btn.id === "setOut") {
                                        const cur = Math.round(
                                            state.seekerCurrentTime,
                                        );
                                        const curStart = Math.round(start);
                                        setCropTimes(
                                            Math.min(
                                                curStart,
                                                Math.max(0, cur - 1),
                                            ),
                                            cur,
                                        );
                                        if (state.isPlaying) playAudio();
                                    } else if (btn.id === "loop") {
                                        state.isLooping = !state.isLooping;
                                    } else if (btn.id === "reset") {
                                        setCropTimes(0, 0);
                                        state.seekerCurrentTime = 0;
                                        if (state.isPlaying) playAudio();
                                    }
                                    node.setDirtyCanvas(true, true);
                                    return true;
                                }
                            }
                        }

                        // Seeker Bar Interactions
                        if (
                            px >= bx &&
                            px <= bx + bw &&
                            py >= by &&
                            py <= by + bh
                        ) {
                            if (
                                isCropped &&
                                Math.abs(px - cropPxStart) <= handleHitRadius
                            ) {
                                state.drag = {
                                    mode: "start",
                                    startX: px,
                                    otherVal: end,
                                };
                            } else if (
                                isCropped &&
                                Math.abs(px - cropPxEnd) <= handleHitRadius
                            ) {
                                state.drag = {
                                    mode: "end",
                                    startX: px,
                                    otherVal: start,
                                };
                            } else if (
                                isCropped &&
                                px > cropPxStart + handleHitRadius &&
                                px < cropPxEnd - handleHitRadius
                            ) {
                                state.drag = {
                                    mode: "move",
                                    startX: px,
                                    origStart: start,
                                    origEnd: end,
                                    moved: false,
                                };
                            } else {
                                const seekTime = pxToTime(px);
                                state.seekerCurrentTime = seekTime;
                                if (state.isPlaying) {
                                    playAudio();
                                }
                                state.drag = { mode: "seeker", startX: px };
                                node.setDirtyCanvas(true, true);
                            }
                            return true;
                        }
                    }

                    // Button Hover on Pointer Move
                    if (t === "pointermove" || t === "mousemove") {
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
                    }

                    // Active Dragging
                    const drag = state.drag;
                    if (drag) {
                        if (t === "pointermove" || t === "mousemove") {
                            // If mouse button is released, stop dragging immediately
                            if (
                                event &&
                                typeof event.buttons === "number" &&
                                event.buttons === 0
                            ) {
                                state.drag = null;
                                node.setDirtyCanvas(true, true);
                                return true;
                            }

                            if (drag.mode === "seeker") {
                                const seekTime = pxToTime(clampX(px));
                                state.seekerCurrentTime = seekTime;
                                node.setDirtyCanvas(true, true);
                            } else if (drag.mode === "start") {
                                const newTime = Math.round(
                                    pxToTime(clampX(px)),
                                );
                                const other = Math.round(drag.otherVal);
                                setCropTimes(
                                    Math.min(newTime, Math.max(0, other - 1)),
                                    other,
                                );
                            } else if (drag.mode === "end") {
                                const newTime = Math.round(
                                    pxToTime(clampX(px)),
                                );
                                const other = Math.round(drag.otherVal);
                                setCropTimes(
                                    other,
                                    Math.max(newTime, other + 1),
                                );
                            } else if (drag.mode === "move") {
                                if (!drag.moved) {
                                    if (Math.abs(px - drag.startX) > 4) {
                                        drag.moved = true;
                                    }
                                }
                                if (drag.moved) {
                                    const deltaSec = Math.round(
                                        ((px - drag.startX) / bw) * totalDur,
                                    );
                                    const origS = Math.round(drag.origStart);
                                    const origE = Math.round(drag.origEnd);
                                    const winLen = Math.max(1, origE - origS);
                                    let newS = origS + deltaSec;
                                    let newE = origE + deltaSec;
                                    if (newS < 0) {
                                        newS = 0;
                                        newE = winLen;
                                    }
                                    if (newE > totalDur) {
                                        newE = Math.round(totalDur);
                                        newS = Math.max(0, newE - winLen);
                                    }
                                    setCropTimes(newS, newE);
                                }
                            }
                            return true;
                        }

                        if (t === "pointerup" || t === "mouseup") {
                            if (drag.mode === "move" && !drag.moved) {
                                const seekTime = pxToTime(drag.startX);
                                state.seekerCurrentTime = seekTime;
                                if (state.isPlaying) {
                                    playAudio();
                                }
                            }
                            state.drag = null;
                            node.setDirtyCanvas(true, true);
                            return true;
                        }
                    }

                    return false;
                },
            };

            // Global mouseup / pointerup listener to ensure audio drag states never stick
            const onGlobalPointerUp = () => {
                if (state.drag) {
                    state.drag = null;
                    node.setDirtyCanvas(true, true);
                }
            };
            window.addEventListener("pointerup", onGlobalPointerUp);
            window.addEventListener("mouseup", onGlobalPointerUp);

            // Mouse Move handler for ? icon hover and drag
            const origOnMouseMove = node.onMouseMove;
            node.onMouseMove = function (e, localPos) {
                const [px, py] = localPos;

                // Safety: if mouse button is not currently down, release any active drag targets
                const isMouseDown =
                    e && typeof e.buttons === "number" ? e.buttons > 0 : true;
                if (state.drag && !isMouseDown) {
                    state.drag = null;
                    node.setDirtyCanvas(true, true);
                }

                const titleH =
                    (typeof LiteGraph !== "undefined" &&
                        LiteGraph.NODE_TITLE_HEIGHT) ||
                    30;
                const helpCx = node.size[0] - 20;
                const helpCy = -titleH / 2;
                const helpDist = Math.hypot(px - helpCx, py - helpCy);
                const isHelpHover = helpDist <= 12;
                if (isHelpHover !== state.helpHovered) {
                    state.helpHovered = isHelpHover;
                    node.setDirtyCanvas(true, true);
                }
                return origOnMouseMove?.apply(this, arguments);
            };

            // Draw Help Button & Floating Shortcut Guide Popup
            function drawHelpBadgeAndPopup(ctx, node, isHovered) {
                const titleH =
                    (typeof LiteGraph !== "undefined" &&
                        LiteGraph.NODE_TITLE_HEIGHT) ||
                    30;
                const cx = node.size[0] - 20;
                const cy = -titleH / 2;
                const r = 8;

                ctx.save();
                ctx.beginPath();
                ctx.arc(cx, cy, r, 0, Math.PI * 2);
                ctx.fillStyle = isHovered
                    ? C.accent
                    : "rgba(255, 255, 255, 0.15)";
                ctx.fill();
                ctx.strokeStyle = isHovered
                    ? C.accentGlow
                    : "rgba(255, 255, 255, 0.35)";
                ctx.lineWidth = 1;
                ctx.stroke();

                ctx.fillStyle = isHovered ? "#000" : "#fff";
                ctx.font = "bold 10px sans-serif";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText("?", cx, cy);

                if (isHovered) {
                    const popW = 330;
                    const popH = 224;
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
                        "AUDIO LOADER & CROP SHORTCUTS",
                        popX + 10,
                        popY + 18,
                    );

                    const shortcuts = [
                        { key: "Space", desc: "Play / Pause audio playback" },
                        {
                            key: "← / →  or  [ / ]",
                            desc: "Step backward / forward 1.0s",
                        },
                        { key: "I", desc: "Set start crop time" },
                        { key: "O", desc: "Set end crop time" },
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

                    curY += 4;
                    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
                    ctx.beginPath();
                    ctx.moveTo(popX + 10, curY);
                    ctx.lineTo(popX + popW - 10, curY);
                    ctx.stroke();
                    curY += 16;

                    ctx.fillStyle = C.textDim;
                    ctx.font = "bold 10px sans-serif";
                    ctx.fillText("MOUSE CONTROLS:", popX + 10, curY);
                    curY += 15;

                    ctx.font = "10px sans-serif";
                    ctx.fillStyle = C.text;
                    ctx.fillText(
                        "• Drag cyan pins to adjust Start/End crop points",
                        popX + 10,
                        curY,
                    );
                    curY += 14;
                    ctx.fillText(
                        "• Drag between handles to slide crop window • Click outside to reset",
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
                drawHelpBadgeAndPopup(ctx, node, state.helpHovered);
                return ret;
            };

            // Helper to check if this audio node is currently active / focused
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

            // Keyboard Shortcuts for Audio Node
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
                    if (state.isPlaying) stopAudio(false);
                    else playAudio();
                } else if (
                    code === "ArrowLeft" ||
                    key === "ArrowLeft" ||
                    code === "BracketLeft" ||
                    key === "["
                ) {
                    e.preventDefault();
                    e.stopPropagation();
                    state.seekerCurrentTime = Math.max(
                        0,
                        state.seekerCurrentTime - 1.0,
                    );
                    if (state.isPlaying) playAudio();
                    node.setDirtyCanvas(true, true);
                } else if (
                    code === "ArrowRight" ||
                    key === "ArrowRight" ||
                    code === "BracketRight" ||
                    key === "]"
                ) {
                    e.preventDefault();
                    e.stopPropagation();
                    state.seekerCurrentTime = Math.min(
                        state.duration || 0,
                        state.seekerCurrentTime + 1.0,
                    );
                    if (state.isPlaying) playAudio();
                    node.setDirtyCanvas(true, true);
                } else if (key === "i" || key === "I" || code === "KeyI") {
                    e.preventDefault();
                    e.stopPropagation();
                    const { end } = getCropTimes();
                    const cur = Math.round(state.seekerCurrentTime);
                    const curEnd = Math.round(
                        end > 0 ? end : state.duration || 0,
                    );
                    setCropTimes(cur, Math.max(cur + 1, curEnd));
                } else if (key === "o" || key === "O" || code === "KeyO") {
                    e.preventDefault();
                    e.stopPropagation();
                    const { start } = getCropTimes();
                    const cur = Math.round(state.seekerCurrentTime);
                    setCropTimes(Math.min(start, Math.max(0, cur - 1)), cur);
                }
            };
            window.addEventListener("keydown", onKeyDown, { capture: true });

            // Cleanup listener on removal
            const origOnRemoved = node.onRemoved;
            node.onRemoved = function () {
                window.removeEventListener("keydown", onKeyDown, {
                    capture: true,
                });
                window.removeEventListener("pointerup", onGlobalPointerUp);
                window.removeEventListener("mouseup", onGlobalPointerUp);
                stopAudio(false);
                return origOnRemoved?.apply(this, arguments);
            };

            // In Vue (Nodes 2.0) mode the widget mirror prefers computedHeight
            // over computeSize — but computedHeight is a stale graph-units
            // value from the canvas-mode layout. Hide it there so the mirror
            // falls back to computeSize with the card's real CSS width.
            {
                let storedHeight;
                Object.defineProperty(waveformWidget, "computedHeight", {
                    configurable: true,
                    get() {
                        return isVueMode() ? undefined : storedHeight;
                    },
                    set(v) {
                        storedHeight = v;
                    },
                });
            }

            // Ensure any setDirtyCanvas triggers Vue widget redraw when in Vue mode
            const origSetDirtyCanvas = node.setDirtyCanvas;
            let inTriggerDraw = false;
            node.setDirtyCanvas = function () {
                const r = origSetDirtyCanvas?.apply(this, arguments);
                if (isVueMode() && !inTriggerDraw) {
                    inTriggerDraw = true;
                    try {
                        waveformWidget.triggerDraw?.();
                    } finally {
                        inTriggerDraw = false;
                    }
                }
                return r;
            };

            node.addCustomWidget(waveformWidget);

            // Ensure node computeSize enforces min width and height
            const prevComputeSize = node.computeSize;
            node.computeSize = function (out) {
                const min = prevComputeSize
                    ? prevComputeSize.apply(this, arguments)
                    : [MIN_NODE_WIDTH, MIN_NODE_HEIGHT];
                const w = Math.max(min?.[0] || 0, MIN_NODE_WIDTH);
                const h = Math.max(min?.[1] || 0, MIN_NODE_HEIGHT);
                if (out) {
                    out[0] = w;
                    out[1] = h;
                    return out;
                }
                return [w, h];
            };

            return result;
        };
    },
});
