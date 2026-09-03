import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const MARGIN = 10;
const HANDLE = 8;
const MIN_SEL = 6;
const MIN_EDITOR_H = 80;
const RESIZE_CORNER_SIZE = 20;

const DEBUG = false;
function dbg(...args) {
    if (DEBUG) console.log("[reference-loader]", ...args);
}

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

function parseImageValue(value) {
    if (!value) return null;
    if (typeof value === "object") {
        if (value.filename) {
            return {
                filename: value.filename,
                type: value.type || "input",
                subfolder: value.subfolder || "",
            };
        }
    }
    let filename = String(value);
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

function parseAspectRatio(value) {
    if (!value || value === "none" || value === "None") return null;
    const parts = String(value).split(":").map(Number);
    if (
        parts.length === 2 &&
        parts[0] > 0 &&
        parts[1] > 0 &&
        Number.isFinite(parts[0]) &&
        Number.isFinite(parts[1])
    ) {
        return parts[0] / parts[1];
    }
    return null;
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

app.registerExtension({
    name: "reference_loader.load_image_crop",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "LoadImageCrop") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            const node = this;
            node.resizable = true;
            const imageWidget = node.widgets.find((w) => w.name === "image");
            const cropWidget = node.widgets.find((w) => w.name === "crop");

            if (cropWidget) {
                cropWidget.hidden = true;
                cropWidget.options = cropWidget.options || {};
                cropWidget.options.hidden = true;
            }

            const isVueMode = () =>
                typeof LiteGraph !== "undefined" && !!LiteGraph.vueNodesMode;
            const ui = () =>
                isVueMode()
                    ? { font: 13, row: 18, handle: 12 }
                    : { font: 10, row: 14, handle: HANDLE };

            if (!isVueMode()) {
                node.previewMediaType = "image";
            }
            node.imageIndex = 0;
            node.hideOutputImages = true;

            // Suppress default background preview
            node.onDrawBackground = (_ctx) => {};

            function removeStockPreviewWidget() {
                if (!node.widgets) return;
                const idx = node.widgets.findIndex(
                    (w) => w.name === "$$canvas-image-preview",
                );
                if (idx > -1) {
                    node.widgets[idx].onRemove?.();
                    node.widgets.splice(idx, 1);
                }
            }
            removeStockPreviewWidget();

            const state = {
                img: null,
                rect: null, // normalized {x,y,w,h} or null = full image
                drag: null,
                box: null, // node-space letterbox of the image, set by draw()
                lastDrawW: null,
                lastLoadedUrl: null,
                helpHovered: false,
            };

            try {
                const saved = cropWidget?.value
                    ? JSON.parse(cropWidget.value)
                    : null;
                if (saved && saved.w > 0 && saved.h > 0) state.rect = saved;
            } catch (e) {
                state.rect = null;
            }

            function syncCrop() {
                if (!cropWidget) return;
                let value = "";
                if (
                    state.rect &&
                    state.rect.w > 0.001 &&
                    state.rect.h > 0.001
                ) {
                    const r = state.rect;
                    // Treat a selection of (almost) everything as no crop.
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
                    dbg("crop synced:", value || "(cleared)");
                }
            }

            function previewHeight(width) {
                if (!state.img) return 100;
                // Exact aspect fit so the image always spans the full width.
                return Math.round(width * (state.img.height / state.img.width));
            }

            function cropDims() {
                if (!state.img || !state.rect) return [0, 0];
                const iw = state.img.width;
                const ih = state.img.height;
                const r = state.rect;
                const x0 = Math.max(0, Math.min(iw - 1, Math.round(r.x * iw)));
                const y0 = Math.max(0, Math.min(ih - 1, Math.round(r.y * ih)));
                const x1 = Math.max(
                    x0 + 1,
                    Math.min(iw, Math.round((r.x + r.w) * iw)),
                );
                const y1 = Math.max(
                    y0 + 1,
                    Math.min(ih, Math.round((r.y + r.h) * ih)),
                );
                return [x1 - x0, y1 - y0];
            }

            // Returns [w, h] after max_megapixels and divisible_by adjustments,
            // or null if neither changes this size.
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
                if (divVal && divVal !== "disabled") {
                    const div = parseInt(divVal, 10);
                    if (div > 1) {
                        targetW = Math.max(
                            div,
                            Math.round(targetW / div) * div,
                        );
                        targetH = Math.max(
                            div,
                            Math.round(targetH / div) * div,
                        );
                    }
                }
                if (targetW === w && targetH === h) return null;
                return [targetW, targetH];
            }

            function getTargetAspectRatio() {
                const w = node.widgets?.find((x) => x.name === "aspect_ratio");
                return parseAspectRatio(w ? w.value : null);
            }

            function applyAspectRatioConstraint() {
                const targetRatio = getTargetAspectRatio();
                if (!targetRatio || !state.rect || !state.img) return;

                const iw = state.img.width;
                const ih = state.img.height;
                const r = state.rect;

                const pw = r.w * iw;
                const ph = r.h * ih;
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

                if (newPw > iw) {
                    newPw = iw;
                    newPh = iw / targetRatio;
                }
                if (newPh > ih) {
                    newPh = ih;
                    newPw = ih * targetRatio;
                }

                const newW = newPw / iw;
                const newH = newPh / ih;

                const newX = Math.max(0, Math.min(1 - newW, cx - newW / 2));
                const newY = Math.max(0, Math.min(1 - newH, cy - newH / 2));

                state.rect = {
                    x: newX,
                    y: newY,
                    w: newW,
                    h: newH,
                };
                syncCrop();
            }

            function hitTest(px, py) {
                if (!state.rect || !state.box) return { mode: "new" };
                const handle = ui().handle;
                const { bx, by, bw, bh } = state.box;
                const sx = bx + state.rect.x * bw;
                const sy = by + state.rect.y * bh;
                const sw = state.rect.w * bw;
                const sh = state.rect.h * bh;
                const corners = {
                    nw: [sx, sy],
                    ne: [sx + sw, sy],
                    sw: [sx, sy + sh],
                    se: [sx + sw, sy + sh],
                };
                for (const [name, [cx, cy]] of Object.entries(corners)) {
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

            const editor = {
                name: "crop_editor",
                type: "reference_loader_cropeditor",
                value: "",
                serialize: false,
                options: { serialize: false },

                // Growable widget: fills available vertical space in canvas layout
                computeLayoutSize: (n) => {
                    if (isVueMode()) {
                        // Vue cards auto-size vertically: keep exact aspect
                        const w = state.lastDrawW || (n?.size?.[0] ?? 200);
                        const h =
                            previewHeight(Math.max(1, w - MARGIN * 2)) +
                            ui().row +
                            8;
                        return { minHeight: h, maxHeight: h, minWidth: 0 };
                    }
                    return {
                        minHeight: MIN_EDITOR_H,
                        maxHeight: 100000,
                        minWidth: 0,
                    };
                },

                draw: function (ctx, _node, widgetWidth, y, H, lowQuality) {
                    const u = ui();
                    const h = (this.computedHeight ?? H) - 8;
                    const x = MARGIN;
                    const nodeW = _node?.size?.[0];
                    const effWidth =
                        !isVueMode() && nodeW
                            ? Math.min(widgetWidth, nodeW)
                            : widgetWidth;
                    state.lastDrawW = effWidth;
                    const w = effWidth - MARGIN * 2;
                    const imgAreaH = Math.max(1, h - u.row);

                    ctx.save();

                    if (!state.img) {
                        ctx.fillStyle = "#00000033";
                        ctx.fillRect(x, y, w, h);
                        ctx.fillStyle = "#888";
                        ctx.font = `${u.font + 2}px sans-serif`;
                        ctx.textAlign = "center";
                        ctx.textBaseline = "middle";
                        ctx.fillText("no image", x + w / 2, y + h / 2);
                        ctx.restore();
                        return;
                    }

                    const scale = Math.min(
                        w / state.img.width,
                        imgAreaH / state.img.height,
                    );
                    const bw = state.img.width * scale;
                    const bh = state.img.height * scale;
                    const bx = x + (w - bw) / 2;
                    const by = y + (imgAreaH - bh) / 2;
                    state.box = { bx, by, bw, bh };
                    ctx.drawImage(state.img, bx, by, bw, bh);

                    if (state.rect && !lowQuality) {
                        const sx = bx + state.rect.x * bw;
                        const sy = by + state.rect.y * bh;
                        const sw = state.rect.w * bw;
                        const sh = state.rect.h * bh;

                        // Dim everything outside the selection
                        ctx.beginPath();
                        ctx.rect(bx, by, bw, bh);
                        ctx.rect(sx, sy, sw, sh);
                        ctx.fillStyle = "rgba(0,0,0,0.55)";
                        ctx.fill("evenodd");

                        ctx.strokeStyle = "#4af";
                        ctx.lineWidth = 1;
                        ctx.strokeRect(sx, sy, sw, sh);
                        ctx.fillStyle = "#4af";
                        for (const [hx, hy] of [
                            [sx, sy],
                            [sx + sw, sy],
                            [sx, sy + sh],
                            [sx + sw, sy + sh],
                        ]) {
                            ctx.fillRect(hx - 2.5, hy - 2.5, 5, 5);
                        }

                        // Crop dimensions pill above selection
                        ctx.font = `${u.font}px sans-serif`;
                        ctx.textAlign = "left";
                        ctx.textBaseline = "alphabetic";
                        const pillH = u.font + 2;

                        const drawPill = (segments, ty) => {
                            const widths = segments.map(
                                (s) => ctx.measureText(s[0]).width,
                            );
                            const tw = widths.reduce((a, b) => a + b, 0);
                            const tx = Math.max(
                                bx,
                                Math.min(
                                    sx + (sw - tw - 6) / 2,
                                    bx + bw - tw - 6,
                                ),
                            );
                            ctx.fillStyle = "rgba(0,0,0,0.6)";
                            ctx.fillRect(tx, ty - pillH + 3, tw + 6, pillH);
                            let cx = tx + 3;
                            for (const [
                                i,
                                [text, color],
                            ] of segments.entries()) {
                                ctx.fillStyle = color;
                                ctx.fillText(text, cx, ty);
                                cx += widths[i];
                            }
                        };

                        const [pw, ph] = cropDims();
                        drawPill(
                            [[`${pw} x ${ph}`, "#fff"]],
                            sy > y + pillH + 2 ? sy - 3 : sy + pillH - 1,
                        );
                        const capped = cappedDims(pw, ph);
                        if (capped) {
                            const belowY = sy + sh + pillH - 1;
                            const ty =
                                belowY < y + imgAreaH - 2
                                    ? belowY
                                    : sy + sh - 4;
                            drawPill(
                                [
                                    ["Output: ", "#aaa"],
                                    [`${capped[0]} x ${capped[1]}`, "#fff"],
                                ],
                                ty,
                            );
                        }
                    }

                    if (!lowQuality) {
                        const lg =
                            typeof LiteGraph === "undefined" ? {} : LiteGraph;
                        const textColor = lg.WIDGET_TEXT_COLOR || "#ddd";
                        const MUTED_ALPHA = 0.45;
                        const iw = state.img.width;
                        const ih = state.img.height;
                        const segments = [
                            ["Full: ", true],
                            [`${iw} x ${ih}`, false],
                        ];
                        if (!state.rect) {
                            const capped = cappedDims(iw, ih);
                            if (capped) {
                                segments.push(
                                    ["   Output: ", true],
                                    [`${capped[0]} x ${capped[1]}`, false],
                                );
                            }
                        }
                        ctx.font = `${u.font}px sans-serif`;
                        ctx.textBaseline = "alphabetic";
                        ctx.textAlign = "left";
                        ctx.fillStyle = textColor;
                        const ty = y + h - 3;
                        const total = segments.reduce(
                            (sum, s) => sum + ctx.measureText(s[0]).width,
                            0,
                        );
                        let cx = x + (w - total) / 2;
                        const prevAlpha = ctx.globalAlpha;
                        for (const [text, muted] of segments) {
                            ctx.globalAlpha = muted
                                ? prevAlpha * MUTED_ALPHA
                                : prevAlpha;
                            ctx.fillText(text, cx, ty);
                            cx += ctx.measureText(text).width;
                        }
                        ctx.globalAlpha = prevAlpha;
                    }

                    ctx.restore();
                },

                mouse: function (event, pos, _node) {
                    if (!state.img || !state.box) return false;
                    const t = event.type;
                    const px =
                        isVueMode() && typeof event?.offsetX === "number"
                            ? event.offsetX
                            : pos[0];
                    const py =
                        isVueMode() && typeof event?.offsetY === "number"
                            ? event.offsetY
                            : pos[1];
                    const { bx, by, bw, bh } = state.box;
                    const clampX = (v) => Math.max(bx, Math.min(bx + bw, v));
                    const clampY = (v) => Math.max(by, Math.min(by + bh, v));

                    if (t === "pointerdown" || t === "mousedown") {
                        if (!isVueMode() && isNodeCorner(px, py, _node || node)) {
                            return false;
                        }
                        if (
                            px < bx ||
                            px > bx + bw ||
                            py < by ||
                            py > by + bh
                        ) {
                            return false;
                        }
                        state.drag = {
                            ...hitTest(px, py),
                            startX: px,
                            startY: py,
                            moved: false,
                        };
                        const el = event.target;
                        if (el?.style) {
                            el.style.cursor =
                                state.drag.mode === "move"
                                    ? "grabbing"
                                    : state.drag.mode === "resize"
                                      ? state.drag.corner === "nw" ||
                                        state.drag.corner === "se"
                                          ? "nwse-resize"
                                          : "nesw-resize"
                                      : "crosshair";
                        }
                        this.triggerDraw?.();
                        return true;
                    }

                    const drag = state.drag;
                    if (!drag) return false;

                    if (t === "pointermove" || t === "mousemove") {
                        if (
                            Math.abs(px - drag.startX) +
                                Math.abs(py - drag.startY) >
                            2
                        ) {
                            drag.moved = true;
                        }
                        if (drag.mode === "new") {
                            const targetRatio = getTargetAspectRatio();
                            if (targetRatio) {
                                const dx = px - drag.startX;
                                const dy = py - drag.startY;
                                const signX = dx >= 0 ? 1 : -1;
                                const signY = dy >= 0 ? 1 : -1;

                                const maxW =
                                    signX > 0
                                        ? bx + bw - drag.startX
                                        : drag.startX - bx;
                                const maxH =
                                    signY > 0
                                        ? by + bh - drag.startY
                                        : drag.startY - by;

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

                                let w, h;
                                if (absDx >= absDy * targetRatio) {
                                    w = Math.min(absDx, maxW_allowed);
                                    h = w / targetRatio;
                                } else {
                                    h = Math.min(absDy, maxH_allowed);
                                    w = h * targetRatio;
                                }

                                if (w >= MIN_SEL && h >= MIN_SEL) {
                                    const x0 =
                                        signX > 0
                                            ? drag.startX
                                            : drag.startX - w;
                                    const y0 =
                                        signY > 0
                                            ? drag.startY
                                            : drag.startY - h;
                                    state.rect = {
                                        x: (x0 - bx) / bw,
                                        y: (y0 - by) / bh,
                                        w: w / bw,
                                        h: h / bh,
                                    };
                                }
                            } else {
                                const x0 = clampX(Math.min(drag.startX, px));
                                const y0 = clampY(Math.min(drag.startY, py));
                                const x1 = clampX(Math.max(drag.startX, px));
                                const y1 = clampY(Math.max(drag.startY, py));
                                if (x1 - x0 >= MIN_SEL && y1 - y0 >= MIN_SEL) {
                                    state.rect = {
                                        x: (x0 - bx) / bw,
                                        y: (y0 - by) / bh,
                                        w: (x1 - x0) / bw,
                                        h: (y1 - y0) / bh,
                                    };
                                }
                            }
                        } else if (drag.mode === "move" && state.rect) {
                            let nx = (clampX(px - drag.offX) - bx) / bw;
                            let ny = (clampY(py - drag.offY) - by) / bh;
                            nx = Math.max(0, Math.min(1 - state.rect.w, nx));
                            ny = Math.max(0, Math.min(1 - state.rect.h, ny));
                            state.rect.x = nx;
                            state.rect.y = ny;
                        } else if (drag.mode === "resize" && state.rect) {
                            const targetRatio = getTargetAspectRatio();
                            const r = state.rect;
                            let x0 = bx + r.x * bw;
                            let y0 = by + r.y * bh;
                            let x1 = x0 + r.w * bw;
                            let y1 = y0 + r.h * bh;

                            if (targetRatio) {
                                let anchorX, anchorY, signX, signY, maxW, maxH;
                                if (drag.corner === "se") {
                                    anchorX = x0;
                                    anchorY = y0;
                                    signX = 1;
                                    signY = 1;
                                    maxW = bx + bw - anchorX;
                                    maxH = by + bh - anchorY;
                                } else if (drag.corner === "nw") {
                                    anchorX = x1;
                                    anchorY = y1;
                                    signX = -1;
                                    signY = -1;
                                    maxW = anchorX - bx;
                                    maxH = anchorY - by;
                                } else if (drag.corner === "ne") {
                                    anchorX = x0;
                                    anchorY = y1;
                                    signX = 1;
                                    signY = -1;
                                    maxW = bx + bw - anchorX;
                                    maxH = anchorY - by;
                                } else if (drag.corner === "sw") {
                                    anchorX = x1;
                                    anchorY = y0;
                                    signX = -1;
                                    signY = 1;
                                    maxW = anchorX - bx;
                                    maxH = by + bh - anchorY;
                                }

                                const maxW_allowed = Math.max(
                                    0,
                                    Math.min(maxW, maxH * targetRatio),
                                );
                                const maxH_allowed = Math.max(
                                    0,
                                    Math.min(maxH, maxW / targetRatio),
                                );

                                const dx = (px - anchorX) * signX;
                                const dy = (py - anchorY) * signY;

                                const absDx = Math.max(0, dx);
                                const absDy = Math.max(0, dy);

                                let w, h;
                                if (absDx >= absDy * targetRatio) {
                                    w = Math.min(absDx, maxW_allowed);
                                    h = w / targetRatio;
                                } else {
                                    h = Math.min(absDy, maxH_allowed);
                                    w = h * targetRatio;
                                }

                                if (w >= MIN_SEL && h >= MIN_SEL) {
                                    const rx0 =
                                        signX > 0 ? anchorX : anchorX - w;
                                    const ry0 =
                                        signY > 0 ? anchorY : anchorY - h;
                                    state.rect = {
                                        x: (rx0 - bx) / bw,
                                        y: (ry0 - by) / bh,
                                        w: w / bw,
                                        h: h / bh,
                                    };
                                }
                            } else {
                                if (drag.corner.includes("w")) x0 = clampX(px);
                                if (drag.corner.includes("e")) x1 = clampX(px);
                                if (drag.corner.includes("n")) y0 = clampY(py);
                                if (drag.corner.includes("s")) y1 = clampY(py);
                                if (
                                    Math.abs(x1 - x0) >= MIN_SEL &&
                                    Math.abs(y1 - y0) >= MIN_SEL
                                ) {
                                    state.rect = {
                                        x: (Math.min(x0, x1) - bx) / bw,
                                        y: (Math.min(y0, y1) - by) / bh,
                                        w: Math.abs(x1 - x0) / bw,
                                        h: Math.abs(y1 - y0) / bh,
                                    };
                                }
                            }
                        }
                        this.triggerDraw?.();
                        return true;
                    }

                    if (t === "pointerup" || t === "mouseup") {
                        if (drag.mode === "new" && !drag.moved) {
                            state.rect = null;
                        }
                        state.drag = null;
                        if (event.target?.style) event.target.style.cursor = "";
                        syncCrop();
                        this.triggerDraw?.();
                        return true;
                    }
                    return false;
                },
            };
            const editorWidget = node.addCustomWidget(editor);

            // Ensure any setDirtyCanvas triggers Vue widget redraw when in Vue mode
            const origSetDirtyCanvas = node.setDirtyCanvas;
            let inTriggerDraw = false;
            node.setDirtyCanvas = function () {
                const r = origSetDirtyCanvas?.apply(this, arguments);
                if (isVueMode() && !inTriggerDraw) {
                    inTriggerDraw = true;
                    try {
                        editorWidget.triggerDraw?.();
                    } finally {
                        inTriggerDraw = false;
                    }
                }
                return r;
            };

            function cursorFor(px, py) {
                if (!state.img || !state.box) return "";
                if (isNodeCorner(px, py, node)) return "";
                const { bx, by, bw, bh } = state.box;
                if (px < bx || px > bx + bw || py < by || py > by + bh)
                    return "";
                const hit = hitTest(px, py);
                if (hit.mode === "resize") {
                    return hit.corner === "nw" || hit.corner === "se"
                        ? "nwse-resize"
                        : "nesw-resize";
                }
                if (hit.mode === "move") return "grab";
                return state.rect ? "not-allowed" : "crosshair";
            }

            const prevMouseMove = node.onMouseMove;
            node.onMouseMove = function (_e, pos, graphCanvas) {
                prevMouseMove?.apply(this, arguments);
                const el = graphCanvas?.canvas || app.canvas?.canvas;
                if (!el || state.drag) return;
                if (isNodeCorner(pos[0], pos[1], node)) return;
                const c = cursorFor(pos[0], pos[1]);
                if (c) {
                    el.style.cursor = c;
                }
            };

            const prevMouseLeave = node.onMouseLeave;
            node.onMouseLeave = function () {
                prevMouseLeave?.apply(this, arguments);
                const el = app.canvas?.canvas;
                if (el) el.style.cursor = "";
            };

            // In Vue (Nodes 2.0) mode the widget mirror prefers computedHeight
            // over computeSize — but computedHeight is a stale graph-units
            // value from the canvas-mode layout. Hide it there so the mirror
            // falls back to computeSize with the card's real CSS width.
            {
                let storedHeight;
                Object.defineProperty(editorWidget, "computedHeight", {
                    configurable: true,
                    get() {
                        return isVueMode() ? undefined : storedHeight;
                    },
                    set(v) {
                        storedHeight = v;
                    },
                });
            }

            const mpWidget = node.widgets?.find(
                (w) => w.name === "max_megapixels",
            );
            if (mpWidget) {
                const prevMpCallback = mpWidget.callback;
                mpWidget.callback = function () {
                    const r = prevMpCallback?.apply(this, arguments);
                    editorWidget.triggerDraw?.();
                    node.setDirtyCanvas(true, true);
                    return r;
                };
            }

            const divWidget = node.widgets?.find(
                (w) => w.name === "divisible_by",
            );
            if (divWidget) {
                const prevDivCallback = divWidget.callback;
                divWidget.callback = function () {
                    const r = prevDivCallback?.apply(this, arguments);
                    editorWidget.triggerDraw?.();
                    node.setDirtyCanvas(true, true);
                    return r;
                };
            }

            const aspectWidget = node.widgets?.find(
                (w) => w.name === "aspect_ratio",
            );
            if (aspectWidget) {
                const prevAspectCallback = aspectWidget.callback;
                aspectWidget.callback = function () {
                    const r = prevAspectCallback?.apply(this, arguments);
                    applyAspectRatioConstraint();
                    editorWidget.triggerDraw?.();
                    node.setDirtyCanvas(true, true);
                    return r;
                };
            }

            let loadSeq = 0;
            function loadImage(autoFit = false, forceRefresh = false) {
                removeStockPreviewWidget();
                const seq = ++loadSeq;
                const info = parseImageValue(imageWidget?.value);
                if (info) info.type = clampViewType(info.type);
                if (
                    !info ||
                    !isSafeViewPath(info.filename) ||
                    !isSafeViewPath(info.subfolder)
                ) {
                    dbg(
                        "unsafe /view path, skipping:",
                        info?.filename,
                        info?.subfolder,
                    );
                    state.img = null;
                    state.lastLoadedUrl = null;
                    node.imgs = [];
                    node.images = [];
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

                // If already loaded or in flight and the source hasn't changed, skip re-fetching to prevent tab-switch flicker
                if (
                    !forceRefresh &&
                    state.lastLoadedUrl === baseUrl
                ) {
                    node.setDirtyCanvas(true, true);
                    editorWidget.triggerDraw?.();
                    return;
                }

                const img = new Image();
                img.crossOrigin = "anonymous";
                img.onload = () => {
                    if (seq !== loadSeq) return;
                    state.img = img;
                    state.lastLoadedUrl = baseUrl;
                    node.imgs = [img];
                    node.imageIndex = 0;
                    node.images = [
                        {
                            filename: info.filename,
                            type: info.type,
                            subfolder: info.subfolder,
                        },
                    ];
                    dbg(
                        "image loaded:",
                        info.filename,
                        `${img.width}x${img.height}`,
                    );
                    // Only auto-fit when creating a new node, never when configuring/restoring a workflow
                    if (
                        autoFit &&
                        !isVueMode() &&
                        !node._was_configured &&
                        (!node.size || node.size[1] <= 150)
                    ) {
                        const minSize = node.computeSize();
                        const desired =
                            previewHeight(node.size[0] - MARGIN * 2) +
                            ui().row +
                            8;
                        const height =
                            minSize[1] -
                            MIN_EDITOR_H +
                            Math.max(MIN_EDITOR_H, desired);
                        node.setSize([
                            Math.max(node.size[0], minSize[0]),
                            height,
                        ]);
                    }
                    removeStockPreviewWidget();
                    node.setDirtyCanvas(true, true);
                    editorWidget.triggerDraw?.();
                };
                img.onerror = () => {
                    if (seq !== loadSeq) return;
                    state.img = null;
                    state.lastLoadedUrl = null;
                    node.imgs = [];
                    node.images = [];
                    node.setDirtyCanvas(true, true);
                    editorWidget.triggerDraw?.();
                };
                img.src = url;
            }

            let lastImageVal = imageWidget?.value;
            // Observe direct assignments to imageWidget.value (e.g. from MaskEditor save or upload)
            if (imageWidget) {
                const valProp = Object.getOwnPropertyDescriptor(
                    imageWidget,
                    "value",
                );
                let internalVal = imageWidget.value;
                Object.defineProperty(imageWidget, "value", {
                    get() {
                        return valProp && valProp.get
                            ? valProp.get.call(imageWidget)
                            : internalVal;
                    },
                    set(v) {
                        if (valProp && valProp.set) {
                            valProp.set.call(imageWidget, v);
                        } else {
                            internalVal = v;
                        }
                        if (
                            imageWidget.options?.values &&
                            !imageWidget.options.values.includes(v)
                        ) {
                            imageWidget.options.values.push(v);
                        }
                        if (node.isUploading) {
                            // During onUploadStart, ComfyUI sets imageWidget.value before the upload completes.
                            // Defer loading until onUploadComplete triggers callback.
                            return;
                        }
                        if (v !== lastImageVal) {
                            lastImageVal = v;
                            const isMaskVersion =
                                typeof v === "string" &&
                                v.includes("clipspace-painted-masked-");
                            if (!isMaskVersion) {
                                state.rect = null;
                                syncCrop();
                            }
                            loadImage(false, isMaskVersion);
                        }
                    },
                    configurable: true,
                    enumerable: true,
                });

                const prevCallback = imageWidget.callback;
                imageWidget.callback = function () {
                    const r = prevCallback?.apply(this, arguments);
                    const curVal = imageWidget.value;
                    let isMaskVersion = false;
                    if (curVal !== lastImageVal) {
                        lastImageVal = curVal;
                        isMaskVersion =
                            typeof curVal === "string" &&
                            curVal.includes("clipspace-painted-masked-");
                        if (!isMaskVersion) {
                            state.rect = null;
                            syncCrop();
                        }
                    }
                    loadImage(false, isMaskVersion);
                    return r;
                };
            }

            // Workflow loading assigns widgets_values directly (no widget callbacks)
            const prevOnConfigure = node.onConfigure;
            node.onConfigure = function () {
                node._was_configured = true;
                const r = prevOnConfigure?.apply(this, arguments);
                try {
                    const saved = cropWidget?.value
                        ? JSON.parse(cropWidget.value)
                        : null;
                    state.rect =
                        saved && saved.w > 0 && saved.h > 0 ? saved : null;
                } catch (e) {
                    state.rect = null;
                }
                lastImageVal = imageWidget?.value;
                dbg(
                    "configured; crop:",
                    cropWidget?.value || "(none)",
                    "image:",
                    imageWidget?.value,
                );
                loadImage(false, false);
                return r;
            };

            // Track ? Help button hover on title bar
            const origOnMouseMove = node.onMouseMove;
            node.onMouseMove = function (_e, localPos) {
                const [px, py] = localPos;
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

            // Draw Help Button & Floating Guide Popup
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
                    ? "#4ab4ff"
                    : "rgba(255, 255, 255, 0.15)";
                ctx.fill();
                ctx.strokeStyle = isHovered
                    ? "rgba(74, 180, 255, 0.5)"
                    : "rgba(255, 255, 255, 0.35)";
                ctx.lineWidth = 1;
                ctx.stroke();

                ctx.fillStyle = isHovered ? "#000" : "#fff";
                ctx.font = "bold 10px sans-serif";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText("?", cx, cy);

                if (isHovered) {
                    const popW = 320;
                    const popH = 200;
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

                    ctx.strokeStyle = "#4ab4ff";
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

                    ctx.fillStyle = "#4ab4ff";
                    ctx.font = "bold 11px sans-serif";
                    ctx.textAlign = "left";
                    ctx.fillText(
                        "IMAGE LOADER & CROP GUIDE",
                        popX + 10,
                        popY + 18,
                    );

                    let curY = popY + 48;
                    ctx.font = "10px sans-serif";
                    ctx.fillStyle = "#dbe2ef";
                    ctx.fillText(
                        "• Click & Drag on image to draw an exact crop box",
                        popX + 10,
                        curY,
                    );
                    curY += 18;
                    ctx.fillText(
                        "• Drag inside the selection to move it around",
                        popX + 10,
                        curY,
                    );
                    curY += 18;
                    ctx.fillText(
                        "• Drag any corner handle to resize the crop",
                        popX + 10,
                        curY,
                    );
                    curY += 18;
                    ctx.fillText(
                        "• Click outside (without dragging) to reset to full image",
                        popX + 10,
                        curY,
                    );
                    curY += 18;
                    ctx.fillText(
                        "• Use 'aspect_ratio' to lock drawing to fixed proportions",
                        popX + 10,
                        curY,
                    );
                    curY += 18;
                    ctx.fillText(
                        "• Use 'max_megapixels' and 'divisible_by' for model bounds",
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

            // Ensure context menu contains Open in MaskEditor
            const prevGetExtraMenuOptions = node.getExtraMenuOptions;
            node.getExtraMenuOptions = function (_canvas, options) {
                const r = prevGetExtraMenuOptions?.apply(this, arguments);
                if (!Array.isArray(options)) options = [];

                const hasMaskEditor = options.some(
                    (opt) =>
                        opt?.content &&
                        (opt.content.includes("MaskEditor") ||
                            opt.content.includes("Mask Editor")),
                );
                if (!hasMaskEditor && (node.imgs?.length || state.img)) {
                    options.push({
                        content: "Open in MaskEditor | Image Canvas",
                        callback: () => {
                            if (typeof useMaskEditor === "function") {
                                try {
                                    useMaskEditor().openMaskEditor(node);
                                    return;
                                } catch (e) {}
                            }
                            if (
                                typeof app !== "undefined" &&
                                app.open_maskeditor
                            ) {
                                try {
                                    if (typeof ComfyApp !== "undefined") {
                                        ComfyApp.clipspace_return_node = node;
                                    }
                                    app.open_maskeditor();
                                    return;
                                } catch (e) {}
                            }
                            try {
                                app.canvas?.selectNode?.(node);
                                if (app.executeCommand) {
                                    app.executeCommand(
                                        "Comfy.MaskEditor.OpenMaskEditor",
                                    );
                                } else if (app.command?.execute) {
                                    app.command.execute(
                                        "Comfy.MaskEditor.OpenMaskEditor",
                                    );
                                }
                            } catch (e) {
                                console.error(
                                    "[reference-loader] Failed to open MaskEditor:",
                                    e,
                                );
                            }
                        },
                    });
                }
                return r;
            };

            const origOnRemoved = node.onRemoved;
            node.onRemoved = function () {
                const el = app.canvas?.canvas;
                if (el) el.style.cursor = "";
                state.img = null;
                state.lastLoadedUrl = null;
                return origOnRemoved?.apply(this, arguments);
            };

            loadImage(true); // fresh node: fit to the default image
            return result;
        };
    },
});
