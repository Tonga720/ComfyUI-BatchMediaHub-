import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

/* ---------------------------------------------------------------- 常量与几何 */

const COUNTS = { image: 9, video: 3, audio: 3 };
const PAD = 14;
const GAP = 10;
const RIGHT_GUTTER = 64; // 留给 LiteGraph 在右侧画 15 个输出端口
const CELL_W = 150;
const IMG_H = 108;
const VID_H = 108;
const AUD_H = 74;
const LABEL_H = 22;

const IMG_LABEL_Y = 44;
const IMG_TOP = IMG_LABEL_Y + LABEL_H + 6; // 72
const IMG_BLOCK = 3 * IMG_H + 2 * GAP; // 344
const VID_LABEL_Y = IMG_TOP + IMG_BLOCK + 14; // 430
const VID_TOP = VID_LABEL_Y + LABEL_H + 6;
const AUD_LABEL_Y = VID_TOP + VID_H + 14;
const AUD_TOP = AUD_LABEL_Y + LABEL_H + 6;

const NODE_W = PAD * 2 + 3 * CELL_W + 2 * GAP + RIGHT_GUTTER;
const NODE_H = AUD_TOP + AUD_H + 22;

const KIND_STYLE = {
  image: { title: "图片 · P1–P9（点右上圆点 = 开关）", accept: "image/*" },
  video: { title: "视频 · V1–V3（单段 2–15s）", accept: "video/*" },
  audio: { title: "音频 · A1–A3（合计 ≤15s）", accept: "audio/*" },
};

/* ---------------------------------------------------------------- 状态读写 */

function stateWidget(node) {
  if (node._hubWidget) return node._hubWidget;
  node._hubWidget = node.widgets?.find((w) => w.name === "state") || null;
  return node._hubWidget;
}

function readState(node) {
  if (node._hubState) return node._hubState;
  const w = stateWidget(node);
  let raw = {};
  try {
    raw = JSON.parse(w?.value || "{}");
  } catch (e) {
    raw = {};
  }
  const state = { v: 1, slots: {}, max_video_frames: raw.max_video_frames ?? 121 };
  for (const [kind, count] of Object.entries(COUNTS)) {
    const given = (raw.slots && raw.slots[kind]) || [];
    state.slots[kind] = Array.from({ length: count }, (_, i) => {
      const c = given[i] || {};
      return {
        file: c.file || null,
        on: c.on !== false,
        thumb: c.thumb || null,
        meta: c.meta || {},
      };
    });
  }
  node._hubState = state;
  return state;
}

function writeState(node, state) {
  node._hubState = state;
  const w = stateWidget(node);
  if (w) w.value = JSON.stringify(state);
  node.setDirtyCanvas(true, true);
  app.graph.setDirtyCanvas(true, false);
}

/* ---------------------------------------------------------------- 缩略图 */

function viewURL(name) {
  const q = `filename=${encodeURIComponent(name)}&type=input&subfolder=${encodeURIComponent(
    "batch_media/_thumbs"
  )}`;
  return typeof api.apiURL === "function" ? api.apiURL(`/view?${q}`) : `/view?${q}`;
}

function thumbImage(node, slot) {
  if (!slot.thumb) return null;
  node._thumbs = node._thumbs || {};
  const key = slot.thumb;
  let rec = node._thumbs[key];
  if (!rec) {
    rec = node._thumbs[key] = { img: new Image(), ready: false, failed: false };
    rec.img.onload = () => {
      rec.ready = true;
      node.setDirtyCanvas(true, false);
    };
    rec.img.onerror = () => {
      rec.failed = true;
      node.setDirtyCanvas(true, false);
    };
    rec.img.src = viewURL(key);
  }
  return rec.ready ? rec.img : null;
}

/* ---------------------------------------------------------------- 上传 */

async function uploadFiles(node, kind, files, startIndex) {
  if (!files || !files.length) return;

  const state = readState(node);
  let next = startIndex == null ? -1 : startIndex;
  let filled = 0;
  let failed = 0;
  let full = false;

  for (let n = 0; n < files.length; n++) {
    // 一个文件一个请求：绕开 ComfyUI 的单请求体积上限，也方便看清进度
    node._busy = `正在上传 ${n + 1}/${files.length} … ${files[n].name}`;
    node.setDirtyCanvas(true, false);

    try {
      const fd = new FormData();
      fd.append("files", files[n]);
      const resp = await api.fetchApi("/batch_media/upload", { method: "POST", body: fd });
      const data = await resp.json();
      if (!resp.ok || !data.ok) throw new Error(data.error || `HTTP ${resp.status}`);

      for (const f of data.files || []) {
        if (f.kind !== kind) continue;
        const slots = state.slots[kind];
        let target = next;
        if (target < 0) target = slots.findIndex((s) => !s.file);
        if (target < 0) {
          full = true;
          break;
        }
        stopInline(node, kind, target);
        slots[target] = {
          file: f.name,
          on: true,
          thumb: f.thumb || null,
          meta: {
            width: f.width,
            height: f.height,
            frames: f.frames,
            duration: f.duration,
            size: f.size,
          },
        };
        next = -1;
        filled += 1;
        writeState(node, state);
      }
    } catch (err) {
      failed += 1;
      console.warn("[BatchMediaHub] 上传失败：", files[n].name, err.message || err);
    }
  }

  node._busy = null;
  node.setDirtyCanvas(true, false);

  if (full) notify(node, "该类素材的槽位已满，剩余文件未放入");
  else if (failed) notify(node, `${failed} 个文件上传失败（类型不支持或过大）`, "#ff9a9a", 4000);
  else if (filled) notify(node, `已放入 ${filled} 个素材`, "#7fd0ff", 1800);
}

function notify(node, text, color, ms = 2200) {
  node._notice = text;
  node._noticeColor = color;
  node.setDirtyCanvas(true, false);
  setTimeout(() => {
    node._notice = null;
    node.setDirtyCanvas(true, false);
  }, ms);
}

/* ---------------------------------------------------------------- 弹窗（导入 / 播放） */

function mediaURL(name, sub = "batch_media") {
  const q = `filename=${encodeURIComponent(name)}&type=input&subfolder=${encodeURIComponent(sub)}`;
  return typeof api.apiURL === "function" ? api.apiURL(`/view?${q}`) : `/view?${q}`;
}

const MODAL_CSS = `
.bmh-mask{position:fixed;inset:0;background:rgba(0,0,0,.66);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:'Microsoft YaHei',sans-serif}
.bmh-card{background:#20252a;border:1px solid #3a444c;border-radius:12px;min-width:540px;max-width:min(860px,92vw);max-height:86vh;display:flex;flex-direction:column;box-shadow:0 18px 50px rgba(0,0,0,.55);color:#d6dee3}
.bmh-hd{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 18px;border-bottom:1px solid #333b42;font-size:15px;font-weight:700}
.bmh-x{cursor:pointer;color:#8b969e;font-size:20px;line-height:1;padding:0 4px}
.bmh-x:hover{color:#fff}
.bmh-bd{padding:16px 18px;overflow:auto}
.bmh-drop{border:1.5px dashed #4a5863;border-radius:10px;padding:24px;text-align:center;color:#93a0a9;cursor:pointer;background:#1a1f24;font-size:13px}
.bmh-drop.hot{border-color:#5fd35f;color:#cfd8de;background:#1e2724}
.bmh-list{margin-top:12px;font-size:12.5px;color:#9fb0bb;line-height:1.85;max-height:24vh;overflow:auto}
.bmh-list b{color:#d6dee3;font-weight:600}
.bmh-ft{display:flex;gap:10px;justify-content:flex-end;padding:12px 18px;border-top:1px solid #333b42}
.bmh-btn{background:#2f3a43;border:1px solid #43505b;color:#d6dee3;border-radius:8px;padding:7px 16px;cursor:pointer;font-size:13px}
.bmh-btn:hover{background:#39454f}
.bmh-btn.primary{background:#2f7d4f;border-color:#3f9e66}
.bmh-btn.danger{background:#7a3a3a;border-color:#9c4a4a}
.bmh-btn:disabled{opacity:.45;cursor:not-allowed}
.bmh-meta{font-size:12.5px;color:#8d9aa3;margin-top:8px;line-height:1.7}
.bmh-media{display:flex;align-items:center;justify-content:center;background:#14181b;border-radius:10px;padding:10px;min-height:120px}
.bmh-media img{max-width:100%;max-height:56vh;border-radius:6px;display:block}
.bmh-media video{max-width:100%;max-height:56vh;border-radius:6px;background:#000}
.bmh-media audio{width:100%}
`;

let bmhMask = null;

function ensureCss() {
  if (document.getElementById("bmh-css")) return;
  const s = document.createElement("style");
  s.id = "bmh-css";
  s.textContent = MODAL_CSS;
  document.head.appendChild(s);
}

function closeModal() {
  if (bmhMask) {
    const m = bmhMask;
    bmhMask = null;
    m.remove();
  }
}

function showModal({ title, body, footer }) {
  ensureCss();
  closeModal();
  const mask = document.createElement("div");
  mask.className = "bmh-mask";
  const card = document.createElement("div");
  card.className = "bmh-card";
  card.addEventListener("mousedown", (e) => e.stopPropagation());

  const hd = document.createElement("div");
  hd.className = "bmh-hd";
  const t = document.createElement("div");
  t.textContent = title;
  const x = document.createElement("div");
  x.className = "bmh-x";
  x.textContent = "×";
  x.onclick = closeModal;
  hd.append(t, x);

  const bd = document.createElement("div");
  bd.className = "bmh-bd";
  if (body) bd.appendChild(body);

  const ft = document.createElement("div");
  ft.className = "bmh-ft";
  const buttons = [];
  for (const btn of footer || []) {
    const b = document.createElement("button");
    b.className = `bmh-btn${btn.kind ? " " + btn.kind : ""}`;
    b.textContent = btn.label;
    b.onclick = btn.onClick;
    ft.appendChild(b);
    buttons.push(b);
  }

  card.append(hd, bd, ft);
  mask.appendChild(card);
  mask.addEventListener("mousedown", (e) => {
    if (e.target === mask) closeModal();
  });
  document.body.appendChild(mask);
  bmhMask = mask;
  return { mask, body: bd, footer: ft, buttons };
}

if (typeof window !== "undefined" && !window.__bmhEscBound) {
  window.__bmhEscBound = true;
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && bmhMask) closeModal();
  });
}

function kindFilter(kind, file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const mime = (file.type || "").toLowerCase();
  const exts = {
    image: ["png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff"],
    video: ["mp4", "mov", "webm", "mkv", "avi", "m4v", "mpg", "mpeg"],
    audio: ["wav", "mp3", "flac", "ogg", "m4a", "aac", "opus", "wma"],
  }[kind];
  if (mime.startsWith(kind + "/")) return true;
  return exts.includes(ext);
}

/** 系统文件选择器（不弹自定义窗口）：多选时从该格开始按顺序往里填 */
function pickFiles(node, kind, index) {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = KIND_STYLE[kind].accept;
  input.style.display = "none";
  document.body.appendChild(input);
  input.onchange = () => {
    const files = Array.from(input.files || []);
    input.remove();
    if (files.length) uploadFiles(node, kind, files, index == null ? -1 : index);
  };
  input.click();
}
/** 播放窗：图片放大看、视频/音频直接播 */
function openPlayer(node, kind, index) {
  const state = readState(node);
  const slot = state.slots[kind][index];
  if (!slot.file) return;

  const box = document.createElement("div");
  box.className = "bmh-media";
  if (kind === "image") {
    const img = document.createElement("img");
    img.src = mediaURL(slot.file);
    box.appendChild(img);
  } else if (kind === "video") {
    const v = document.createElement("video");
    v.src = mediaURL(slot.file);
    v.controls = true;
    v.autoplay = true;
    v.loop = true;
    v.playsInline = true;
    box.appendChild(v);
    v.play && v.play().catch(() => {});
  } else {
    const a = document.createElement("audio");
    a.src = mediaURL(slot.file);
    a.controls = true;
    a.autoplay = true;
    box.appendChild(a);
    a.play && a.play().catch(() => {});
  }

  const meta = document.createElement("div");
  meta.className = "bmh-meta";
  const mm = slot.meta || {};
  const bits = [slot.file];
  if (mm.width && mm.height) bits.push(`${mm.width}×${mm.height}`);
  if (kind === "video" && mm.frames) bits.push(`${mm.frames} 帧`);
  if (mm.duration) bits.push(`${mm.duration}s`);
  if (mm.size) bits.push(`${(mm.size / 1024 / 1024).toFixed(2)} MB`);
  bits.push(slot.on ? "已启用" : "已停用");
  meta.textContent = bits.join(" · ");

  const wrap = document.createElement("div");
  wrap.append(box, meta);

  showModal({
    title: `${kind === "image" ? "预览图片" : kind === "video" ? "播放视频" : "播放音频"} · ${
      kind === "image" ? "P" : kind === "video" ? "V" : "A"
    }${index + 1}`,
    body: wrap,
    footer: [
      {
        label: slot.on ? "停用这一格" : "启用这一格",
        onClick: () => {
          slot.on = !slot.on;
          writeState(node, state);
          closeModal();
        },
      },
      {
        label: "替换文件",
        onClick: () => {
          closeModal();
          pickFiles(node, kind, index);
        },
      },
      {
        label: "清空这一格",
        kind: "danger",
        onClick: () => {
          state.slots[kind][index] = { file: null, on: true, thumb: null, meta: {} };
          writeState(node, state);
          closeModal();
        },
      },
      { label: "关闭", kind: "primary", onClick: closeModal },
    ],
  });
}

/* ---------------------------------------------------------------- 内联播放（不开窗口） */

const PLAY_KEY = (kind, index) => `${kind}:${index}`;
let SHARED_AC = null;

function playMap(node) {
  if (!node._play) node._play = Object.create(null);
  return node._play;
}

function startFrameLoop(node) {
  if (node._frameLoop) return;
  let last = 0;
  const tick = (t) => {
    node._frameLoop = null;
    const live = node._play && Object.keys(node._play).length;
    if (!live) return;
    if (t - last > 32) {
      last = t;
      node.setDirtyCanvas(true, false);
    }
    node._frameLoop = requestAnimationFrame(tick);
  };
  node._frameLoop = requestAnimationFrame(tick);
}

function stopInline(node, kind, index) {
  const key = PLAY_KEY(kind, index);
  const rec = node._play && node._play[key];
  if (!rec) return;
  try {
    rec.el.pause();
    rec.el.removeAttribute("src");
    rec.el.load();
  } catch (e) {}
  try {
    rec.srcNode && rec.srcNode.disconnect();
    rec.an && rec.an.disconnect();
    rec.el.remove();
  } catch (e) {}
  delete node._play[key];
  node.setDirtyCanvas(true, false);
}

function stopAllInline(node) {
  for (const k of Object.keys(node._play || {})) {
    const [kind, index] = k.split(":");
    stopInline(node, kind, Number(index));
  }
}

function setupAnalyser(rec) {
  try {
    if (!SHARED_AC) SHARED_AC = new (window.AudioContext || window.webkitAudioContext)();
    if (SHARED_AC.state === "suspended") SHARED_AC.resume().catch(() => {});
    const srcNode = SHARED_AC.createMediaElementSource(rec.el);
    const an = SHARED_AC.createAnalyser();
    an.fftSize = 64;
    an.smoothingTimeConstant = 0.8;
    srcNode.connect(an);
    an.connect(SHARED_AC.destination);
    rec.srcNode = srcNode;
    rec.an = an;
    rec.data = new Uint8Array(an.frequencyBinCount);
  } catch (e) {
    rec.an = null;
  }
}

/** 点一下就开始播；再点一下暂停；同一类型同时只放一个 */
function toggleInline(node, kind, index) {
  const key = PLAY_KEY(kind, index);
  const rec = node._play && node._play[key];
  if (rec) {
    try {
      if (rec.el.paused) rec.el.play().catch(() => {});
      else rec.el.pause();
    } catch (e) {}
    node.setDirtyCanvas(true, false);
    return;
  }

  for (const k of Object.keys(node._play || {})) {
    if (k.split(":")[0] === kind) {
      const [kk, ii] = k.split(":");
      stopInline(node, kk, Number(ii));
    }
  }

  const slot = readState(node).slots[kind][index];
  if (!slot.file) return;

  const el = document.createElement(kind === "video" ? "video" : "audio");
  el.src = mediaURL(slot.file);
  el.loop = true;
  el.playsInline = true;
  el.preload = "auto";
  el.style.display = "none";
  document.body.appendChild(el);

  const pack = { el, kind, index };
  if (kind === "audio") setupAnalyser(pack);
  playMap(node)[key] = pack;

  el.addEventListener("error", () => {
    notify(node, "这个文件浏览器播不了（编码不支持）", "#ff9a9a", 3000);
    stopInline(node, kind, index);
  });
  el.play().catch(() => {});
  startFrameLoop(node);
}
function openCell(node, kind, index, preferWindow = false) {
  const slot = readState(node).slots[kind][index];
  if (!slot.file) {
    pickFiles(node, kind, index);
    return;
  }
  // 视频 / 音频：点一下就在格子里播，不开窗口
  if (!preferWindow && (kind === "video" || kind === "audio")) {
    toggleInline(node, kind, index);
    return;
  }
  if (kind === "image" && !preferWindow) return;
  openPlayer(node, kind, index);
}

/* ---------------------------------------------------------------- 几何 */

const RECTS = (() => {
  const rects = [];
  for (let i = 0; i < 9; i++) {
    rects.push({
      kind: "image",
      index: i,
      x: PAD + (i % 3) * (CELL_W + GAP),
      y: IMG_TOP + Math.floor(i / 3) * (IMG_H + GAP),
      w: CELL_W,
      h: IMG_H,
    });
  }
  for (let i = 0; i < 3; i++) {
    rects.push({ kind: "video", index: i, x: PAD + i * (CELL_W + GAP), y: VID_TOP, w: CELL_W, h: VID_H });
    rects.push({ kind: "audio", index: i, x: PAD + i * (CELL_W + GAP), y: AUD_TOP, w: CELL_W, h: AUD_H });
  }
  return rects;
})();

// 开关 / 清除的热区放大到 16px：想按开关的时候容易点中，格子中间区域仍然是「导入 / 播放」。
const DOT_R = 16;
const CLEAR_R = 14;

function hitTest(x, y) {
  for (const r of RECTS) {
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
      const dx = x - (r.x + r.w - 13);
      const dy = y - (r.y + 13);
      const ex = x - (r.x + 12);
      const ey = y - (r.y + 12);
      return {
        ...r,
        inDot: Math.hypot(dx, dy) <= DOT_R,
        inClear: Math.hypot(ex, ey) <= CLEAR_R,
      };
    }
  }
  return null;
}

/* ---------------------------------------------------------------- 绘制 */

function menuHit(node, canvas) {
  if (node._hubHover) return hitTest(node._hubHover[0], node._hubHover[1]);
  const m = (canvas && canvas.graph_mouse) || (app.canvas && app.canvas.graph_mouse);
  if (!m) return null;
  return hitTest(m[0] - node.pos[0], m[1] - node.pos[1]);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}

function drawLabel(ctx, text, y) {
  ctx.save();
  ctx.fillStyle = "#9aa7b0";
  ctx.font = "bold 12px 'Microsoft YaHei', sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText(text, PAD, y + LABEL_H / 2);
  ctx.restore();
}

function drawPlayBar(ctx, x, y, w, el) {
  const d = el.duration || 0;
  const t = el.currentTime || 0;
  const p = d ? Math.min(1, t / d) : 0;
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(x, y, w, 3);
  ctx.fillStyle = "#5fd35f";
  ctx.fillRect(x, y, w * p, 3);
}

function drawCell(ctx, node, rect, slot) {
  const { x, y, w, h } = rect;
  const has = !!slot.file;
  const rec = node._play && node._play[PLAY_KEY(rect.kind, rect.index)];

  ctx.save();
  roundRect(ctx, x, y, w, h, 0);
  ctx.fillStyle = has ? "#1a1d20" : "#15181b";
  ctx.fill();
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = has ? "#39424a" : "#2e363d";
  if (!has) ctx.setLineDash([5, 4]);
  ctx.stroke();
  ctx.setLineDash([]);

  if (rect.kind === "audio") {
    const paused = rec ? rec.el.paused : true;
    ctx.fillStyle = slot.on ? "#4f8a9c" : "#3a4248";
    let levels = null;
    if (rec && rec.an && !paused) {
      rec.an.getByteFrequencyData(rec.data);
      levels = rec.data;
    }
    for (let b = 0; b < 14; b++) {
      let bh = 8 + Math.abs(Math.sin((rect.index + 1) * (b + 2) * 0.7)) * 30;
      if (levels) {
        const idx = Math.min(levels.length - 1, 2 + b * 2);
        bh = 7 + (levels[idx] / 255) * 32;
      }
      ctx.fillRect(x + 16 + b * 7, y + h / 2 - bh / 2 - 6, 4, bh);
    }
    if (rec) {
      drawPlayBar(ctx, x + 6, y + h - 26, w - 12, rec.el);
    }
  } else {
    const v = rec && rec.el;
    if (v && v.videoWidth) {
      const scale = Math.min((w - 4) / v.videoWidth, (h - 22) / v.videoHeight);
      const dw = v.videoWidth * scale;
      const dh = v.videoHeight * scale;
      ctx.globalAlpha = slot.on ? 1 : 0.55;
      ctx.drawImage(v, x + (w - dw) / 2, y + 2 + (h - 24 - dh) / 2, dw, dh);
      ctx.globalAlpha = 1;
      drawPlayBar(ctx, x + 6, y + h - 26, w - 12, rec.el);
    } else {
      const img = thumbImage(node, slot);
      if (img) {
        const scale = Math.min((w - 4) / img.width, (h - 22) / img.height);
        const dw = img.width * scale;
        const dh = img.height * scale;
        ctx.globalAlpha = slot.on ? 1 : 0.55;
        ctx.drawImage(img, x + (w - dw) / 2, y + 2 + (h - 24 - dh) / 2, dw, dh);
        ctx.globalAlpha = 1;
        // 视频格有个播放角标，提示“点一下就能播”
      } else if (has) {
        ctx.fillStyle = "#2a3238";
        ctx.font = "11px sans-serif";
        ctx.fillText("加载中…", x + 12, y + h / 2);
      } else {
        ctx.fillStyle = "#4a545c";
      ctx.font = "bold 22px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("+", x + w / 2, y + h / 2 + 2);
      ctx.textAlign = "left";
      }
    }
  }

  if (has) {
    ctx.fillStyle = "rgba(0,0,0,0.58)";
    ctx.fillRect(x, y + h - 20, w, 20);
    ctx.fillStyle = "#cfd8de";
    ctx.font = "11px 'Microsoft YaHei', sans-serif";
    const name = slot.file.length > 22 ? slot.file.slice(0, 20) + "…" : slot.file;
    ctx.fillText(name, x + 7, y + h - 6);
    const m = slot.meta || {};
    if (rect.kind === "video" && m.frames) {
      ctx.fillStyle = "#9fb0bb";
      ctx.textAlign = "right";
      ctx.fillText(`${m.frames}f`, x + w - 7, y + h - 6);
      ctx.textAlign = "left";
    } else if (rect.kind === "audio" && m.duration) {
      ctx.fillStyle = "#9fb0bb";
      ctx.textAlign = "right";
      ctx.fillText(`${m.duration}s`, x + w - 7, y + h - 6);
      ctx.textAlign = "left";
    }
  } else {
    ctx.fillStyle = "#46515a";
    ctx.font = "10px 'Microsoft YaHei', sans-serif";
    const tag = rect.kind === "image" ? `P${rect.index + 1}` : rect.kind === "video" ? `V${rect.index + 1}` : `A${rect.index + 1}`;
    ctx.fillText(tag, x + 9, y + 14);
  }

  if (!slot.on) {
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    roundRect(ctx, x, y, w, h, 0);
    ctx.fill();
  }

  // 右上角开关（视觉半径 8，命中半径 16）
  ctx.beginPath();
  ctx.arc(x + w - 13, y + 13, 8, 0, Math.PI * 2);
  ctx.fillStyle = slot.on && has ? "#5fd35f" : "#6d757c";
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.6)";
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // 左上角清除
  if (has) {
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.beginPath();
    ctx.arc(x + 12, y + 12, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#d0d0d0";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(x + 8, y + 8);
    ctx.lineTo(x + 16, y + 16);
    ctx.moveTo(x + 16, y + 8);
    ctx.lineTo(x + 8, y + 16);
    ctx.stroke();
  }

  // 标记：拖文件悬停 / 拖动换位目标 / 拖动的源格
  const marked = (m) => m && m.kind === rect.kind && m.index === rect.index;
  if (marked(node._hubDrop)) {
    roundRect(ctx, x, y, w, h, 0);
    ctx.fillStyle = "rgba(127,208,255,0.12)";
    ctx.fill();
    ctx.setLineDash([]);
    ctx.strokeStyle = "#7fd0ff";
    ctx.lineWidth = 2.5;
    ctx.stroke();
  } else if (marked(node._hubSwap)) {
    roundRect(ctx, x, y, w, h, 0);
    ctx.fillStyle = "rgba(95,211,95,0.14)";
    ctx.fill();
    ctx.setLineDash([]);
    ctx.strokeStyle = "#5fd35f";
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }
  if (marked(node._hubDragSrc)) {
    roundRect(ctx, x, y, w, h, 0);
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = "rgba(207,216,222,0.85)";
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
}

function drawHub(ctx, node) {
  const state = readState(node);
  // 新前端会给 DOM widget 保留一行，这里持续压掉，避免遮挡画面
  const sw = stateWidget(node);
  if (sw?.element && sw.element.style.display !== "none") sw.element.style.display = "none";
  ctx.save();
  ctx.textBaseline = "middle";

  drawLabel(ctx, KIND_STYLE.image.title, IMG_LABEL_Y);
  drawLabel(ctx, KIND_STYLE.video.title, VID_LABEL_Y);
  drawLabel(ctx, KIND_STYLE.audio.title, AUD_LABEL_Y);

  for (const rect of RECTS) drawCell(ctx, node, rect, state.slots[rect.kind][rect.index]);

  // 底部不再常驻操作提示，只在有上传进度 / 临时提示（如互换成功）时才出现
  const hint = node._busy || node._notice;
  if (hint) {
    ctx.fillStyle = node._busy ? "#7fd0ff" : node._noticeColor || "#ff9a9a";
    ctx.font = "11px 'Microsoft YaHei', sans-serif";
    ctx.fillText(hint, PAD, NODE_H - 10);
  }
  ctx.restore();
}

/* ---------------------------------------------------------------- 拖拽上传 */
/* ---------------------------------------------------------------- 指针定位 */

function eventToGraph(e) {
  const cv = app.canvas;
  if (!cv) return null;
  if (cv.convertEventToCanvasOffset) {
    try {
      return cv.convertEventToCanvasOffset(e);
    } catch (err) {}
  }
  const el = cv.canvas || cv.el;
  const r = el.getBoundingClientRect();
  return [(e.clientX - r.left) / cv.ds.scale - cv.ds.offset[0], (e.clientY - r.top) / cv.ds.scale - cv.ds.offset[1]];
}

function cellAtEvent(e) {
  const g = eventToGraph(e);
  if (!g) return null;
  for (const node of app.graph?.nodes || []) {
    if (!node || node.type !== "BatchMediaHub") continue;
    const hit = hitTest(g[0] - node.pos[0], g[1] - node.pos[1]);
    if (hit) return { node, hit };
  }
  return null;
}

function clearHubMarks() {
  for (const n of app.graph?.nodes || []) {
    if (n._hubDrop || n._hubSwap || n._hubDragSrc) {
      n._hubDrop = null;
      n._hubSwap = null;
      n._hubDragSrc = null;
      n.setDirtyCanvas(true, false);
    }
  }
}

function swapSlots(node, a, b) {
  const state = readState(node);
  const A = state.slots[a.kind][a.index];
  const B = state.slots[b.kind][b.index];
  state.slots[a.kind][a.index] = B;
  state.slots[b.kind][b.index] = A;
  stopInline(node, a.kind, a.index);
  stopInline(node, b.kind, b.index);
  writeState(node, state);
}

/* ---------------------------------------------------------------- 拖拽上传文件 */

function installDrop() {
  if (window.__bmhDropBound) return;
  window.__bmhDropBound = true;

  document.addEventListener(
    "dragover",
    (e) => {
      const t = cellAtEvent(e);
      if (!t) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      const cur = t.node._hubDrop;
      if (!cur || cur.kind !== t.hit.kind || cur.index !== t.hit.index) {
        clearHubMarks();
        t.node._hubDrop = { kind: t.hit.kind, index: t.hit.index };
        t.node.setDirtyCanvas(true, false);
      }
    },
    true
  );

  document.addEventListener(
    "dragleave",
    (e) => {
      if (!cellAtEvent(e)) clearHubMarks();
    },
    true
  );

  document.addEventListener(
    "drop",
    (e) => {
      const t = cellAtEvent(e);
      if (!t) {
        clearHubMarks();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      clearHubMarks();
      if (files.length) uploadFiles(t.node, t.hit.kind, files, t.hit.index);
    },
    true
  );
}

/* ---------------------------------------------------------------- 点按 / 拖动互换 */

function installCellDrag() {
  if (window.__bmhDragBound) return;
  window.__bmhDragBound = true;

  const pressed = () => {
    for (const n of app.graph?.nodes || []) if (n._hubPress) return n;
    return null;
  };

  window.addEventListener(
    "mousemove",
    (e) => {
      const n = pressed();
      if (!n) return;
      const p = n._hubPress;
      if (!p.dragging) {
        const t = cellAtEvent(e);
        const dx = t ? t.lx - p.lx : 0;
        const dy = t ? t.ly - p.ly : 0;
        if (!t || Math.hypot(dx, dy) < 6 || p.action !== "cell" || !p.hasFile) return;
        p.dragging = true;
        n._hubDragSrc = { kind: p.hit.kind, index: p.hit.index };
      }
      const t = cellAtEvent(e);
      const same = t && t.node === n && t.hit.kind === p.hit.kind && t.hit.index !== p.hit.index;
      n._hubSwap = same ? { kind: t.hit.kind, index: t.hit.index } : null;
      n.setDirtyCanvas(true, false);
      e.preventDefault();
    },
    true
  );

  const handleUp = (e) => {
    const n = pressed();
    if (!n) return;
    const p = n._hubPress;
    n._hubPress = null;
    clearHubMarks();
    const t = cellAtEvent(e);
    if (t && t.node === n && t.hit.kind === p.hit.kind && t.hit.index !== p.hit.index) {
      swapSlots(n, p.hit, { kind: t.hit.kind, index: t.hit.index });
      notify(n, "两格素材已互换", "#7fd0ff", 1200);
      return;
    }
    const sameCell = !t || (t.node === n && t.hit.kind === p.hit.kind && t.hit.index === p.hit.index);
    if (sameCell) fireCellPress(n, p);
  };
  for (const tgt of [window, document]) {
    tgt.addEventListener("pointerup", handleUp, true);
    tgt.addEventListener("mouseup", handleUp, true);
  }
}

function fireCellPress(node, press) {
  const state = readState(node);
  const slot = state.slots[press.hit.kind][press.hit.index];
  if (press.action === "dot") {
    slot.on = !slot.on;
    if (!slot.on) stopInline(node, press.hit.kind, press.hit.index);
    writeState(node, state);
    return;
  }
  if (press.action === "clear") {
    stopInline(node, press.hit.kind, press.hit.index);
    state.slots[press.hit.kind][press.hit.index] = { file: null, on: true, thumb: null, meta: {} };
    writeState(node, state);
    return;
  }
  openCell(node, press.hit.kind, press.hit.index);
}
/* ---------------------------------------------------------------- 注册 */

app.registerExtension({
  name: "BatchMediaHub.node",
  setup() {
    installDrop();
    installCellDrag();
  },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "BatchMediaHub") return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const ret = onNodeCreated?.apply(this, arguments);
      this._hubState = null;
      this._hubWidget = null;
      this._thumbs = {};
      this._notice = null;
      this.size = [NODE_W, NODE_H];
      this.resizable = false;

      const w = stateWidget(this);
      if (w) {
        // 原生 STRING widget 只作为数据载体，界面由画布自绘
        w.computeSize = () => [0, 0];
        w.draw = () => {};
        w.type = "hidden";
        if (w.element) w.element.style.display = "none";
      }
      return ret;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const ret = onConfigure?.apply(this, arguments);
      this._hubState = null;
      this._hubWidget = null;
      this._thumbs = {};
      stopAllInline(this);
      readState(this);
      this.size = [NODE_W, NODE_H];
      return ret;
    };

    const onDrawForeground = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (ctx) {
      const ret = onDrawForeground?.apply(this, arguments);
      if (this.flags?.collapsed) return ret;
      drawHub(ctx, this);
      return ret;
    };

    const onMouseDown = nodeType.prototype.onMouseDown;
    nodeType.prototype.onMouseDown = function (e, localPos) {
      const hit = localPos ? hitTest(localPos[0], localPos[1]) : null;
      if (!hit) return onMouseDown?.apply(this, arguments) ?? false;

      const slot = readState(this).slots[hit.kind][hit.index];
      let action = "cell";
      if (hit.inDot && slot.file) action = "dot";
      else if (hit.inClear && slot.file) action = "clear";
      // 先只记下这一按，等松手时若没拖动再执行（拖动 = 互换成对调）
      this._hubPress = {
        hit: { kind: hit.kind, index: hit.index },
        action,
        hasFile: !!slot.file,
        lx: localPos[0],
        ly: localPos[1],
        dragging: false,
      };
      return true;
    };

    const onMouseUp = nodeType.prototype.onMouseUp;
    nodeType.prototype.onMouseUp = function (e, localPos) {
      const press = this._hubPress;
      this._hubPress = null;
      if (!press) return onMouseUp?.apply(this, arguments) ?? false;
      const target = localPos ? hitTest(localPos[0], localPos[1]) : null;
      const movedTo = target && target.kind === press.hit.kind && target.index !== press.hit.index;
      clearHubMarks();
      if (movedTo) {
        swapSlots(this, press.hit, { kind: target.kind, index: target.index });
        notify(this, "两格素材已互换", "#7fd0ff", 1200);
        return true;
      }
      if (!target || (target.kind === press.hit.kind && target.index === press.hit.index)) fireCellPress(this, press);
      return true;
    };

    nodeType.prototype.onMouseMove = function (e, pos) {
      if (pos && pos.length >= 2) this._hubHover = [pos[0], pos[1]];
      return false;
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      stopAllInline(this);
      return onRemoved?.apply(this, arguments);
    };

    nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
      if (!options) return;
      const cellItems = [{ content: "———— 当前格子 ————", callback: () => {} }];
      const hit = menuHit(this, canvas);
      if (hit) {
        const state = readState(this);
        const slot = state.slots[hit.kind][hit.index];
        const tag = hit.kind === "image" ? `图${hit.index + 1}` : hit.kind === "video" ? `视频${hit.index + 1}` : `音频${hit.index + 1}`;
        if (slot.file) {
          cellItems.push(
            { content: `【${tag}】${slot.file}`, callback: () => {} },
            {
              content: `打开详情 / 播放窗口（${tag}）`,
              callback: () => {
                stopInline(this, hit.kind, hit.index);
                openPlayer(this, hit.kind, hit.index);
              },
            },
            { content: `替换 ${tag} 素材`, callback: () => pickFiles(this, hit.kind, hit.index) },
            {
              content: slot.on ? `停用 ${tag}` : `启用 ${tag}`,
              callback: () => {
                slot.on = !slot.on;
                if (!slot.on) stopInline(this, hit.kind, hit.index);
                writeState(this, state);
              },
            },
            {
              content: `清空 ${tag}`,
              callback: () => {
                stopInline(this, hit.kind, hit.index);
                state.slots[hit.kind][hit.index] = { file: null, on: true, thumb: null, meta: {} };
                writeState(this, state);
              },
            }
          );
        } else {
          cellItems.push({ content: `上传素材到 ${tag}`, callback: () => pickFiles(this, hit.kind, hit.index) });
        }
      }
      options.unshift(
        { content: "批量上传图片（可多选）", callback: () => pickFiles(this, "image", -1) },
        { content: "批量上传视频", callback: () => pickFiles(this, "video", -1) },
        { content: "批量上传音频", callback: () => pickFiles(this, "audio", -1) },
        {
          content: "全部启用",
          callback: () => {
            const s = readState(this);
            for (const k of Object.keys(COUNTS)) s.slots[k].forEach((x) => (x.on = true));
            writeState(this, s);
          },
        },
        {
          content: "全部停用（保留文件）",
          callback: () => {
            const s = readState(this);
            for (const k of Object.keys(COUNTS)) s.slots[k].forEach((x) => (x.on = false));
            writeState(this, s);
          },
        },
        {
          content: "清空全部素材",
          callback: () => {
            const s = readState(this);
            stopAllInline(this);
            for (const k of Object.keys(COUNTS))
              s.slots[k] = s.slots[k].map(() => ({ file: null, on: true, thumb: null, meta: {} }));
            writeState(this, s);
          },
        },
        { content: "———— 视频帧数上限 ————", callback: () => {} }
      );
      for (const n of [25, 49, 73, 97, 121]) {
        options.push({
          content: `${n} 帧${n === 121 ? "（H3 默认）" : ""}`,
          callback: () => {
            const s = readState(this);
            s.max_video_frames = n;
            writeState(this, s);
          },
        });
      }
      if (cellItems.length > 1) options.unshift(...cellItems);
    };
  },
});