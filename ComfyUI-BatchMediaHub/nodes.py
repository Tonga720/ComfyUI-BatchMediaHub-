"""Batch Media Hub — 一个节点管理 9 图 / 3 视频 / 3 音频的上传与开关。

设计要点
--------
* 前端（web/js/batch_media_hub.js）负责 3×3 图片格 + 3 视频格 + 3 音频格的可视化面板、
  批量上传（一次多选，按类型自动填空位）、每格右上角开关（绿=启用 / 灰=旁路）。
* 每个格子的状态以 JSON 字符串存在 `state` widget 里，随工作流一起保存，不需要额外文件。
* 本文件（后端）负责：接收上传（保存到 input/batch_media/）、生成缩略图、
  执行时按开关读取素材并输出 9×IMAGE + 3×IMAGE(视频帧) + 3×AUDIO。
* 关闭的格子输出 None —— 与“旁路 LoadImage + SetNode”的语义一致，
  MiniMax H3 的参考图/参考视频/参考音频输入本身可缺省。
"""

from __future__ import annotations

import hashlib
import json
import os
import re

import folder_paths
from aiohttp import web
from server import PromptServer

NODE_NAME = "BatchMediaHub"
STORE_SUBDIR = "batch_media"
THUMB_SUBDIR = os.path.join(STORE_SUBDIR, "_thumbs")

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}
VIDEO_EXT = {".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v", ".mpg", ".mpeg"}
AUDIO_EXT = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac", ".opus", ".wma"}

SLOT_COUNTS = {"image": 9, "video": 3, "audio": 3}
MAX_UPLOAD_BYTES = 1024 * 1024 * 1024  # 单文件 1GB 上限


# --------------------------------------------------------------------------- 路径


def _store_dir() -> str:
    return os.path.join(folder_paths.get_input_directory(), STORE_SUBDIR)


def _thumb_dir() -> str:
    return os.path.join(folder_paths.get_input_directory(), THUMB_SUBDIR)


def _ensure_dirs() -> None:
    os.makedirs(_store_dir(), exist_ok=True)
    os.makedirs(_thumb_dir(), exist_ok=True)


def _safe_name(name: str) -> str | None:
    """只接受纯文件名，挡掉路径穿越。"""
    raw = str(name or "").replace("\\", "/")
    base = os.path.basename(raw)
    if not base or base in (".", ".."):
        return None
    if not re.match(r"^[\w\u4e00-\u9fff .\-()\[\]+#@&]+$", base, flags=re.UNICODE):
        base = re.sub(r"[^\w\u4e00-\u9fff .\-()\[\]+#@&]", "_", base, flags=re.UNICODE)
    return base


def _kind_of(name: str) -> str | None:
    ext = os.path.splitext(name)[1].lower()
    if ext in IMAGE_EXT:
        return "image"
    if ext in VIDEO_EXT:
        return "video"
    if ext in AUDIO_EXT:
        return "audio"
    return None


def _unique_path(filename: str) -> str:
    _ensure_dirs()
    base, ext = os.path.splitext(filename)
    dest = os.path.join(_store_dir(), filename)
    i = 1
    while os.path.exists(dest):
        dest = os.path.join(_store_dir(), f"{base}_{i}{ext}")
        i += 1
    return dest


# --------------------------------------------------------------------------- 探测 / 缩略图


def _probe(path: str, kind: str, name: str) -> dict:
    meta = {
        "name": name,
        "kind": kind,
        "size": os.path.getsize(path),
        "thumb": None,
        "width": None,
        "height": None,
        "frames": None,
        "duration": None,
    }
    try:
        if kind == "image":
            meta.update(_probe_image(path, name))
        elif kind == "video":
            meta.update(_probe_video(path, name))
        else:
            meta.update(_probe_audio(path))
    except Exception as exc:  # 探测失败不影响上传本身
        meta["warning"] = str(exc)
    return meta


def _probe_image(path: str, name: str) -> dict:
    from PIL import Image

    with Image.open(path) as im:
        meta = {"width": im.width, "height": im.height}
        thumb = _save_thumb(im.convert("RGB"), name)
        meta["thumb"] = thumb
    return meta


def _probe_video(path: str, name: str) -> dict:
    frames = _decode_video(path, limit=1, strict=False)
    meta = {}
    if frames is not None and len(frames):
        meta["height"], meta["width"] = int(frames[0].shape[0]), int(frames[0].shape[1])
        from PIL import Image

        meta["thumb"] = _save_thumb(Image.fromarray(frames[0]).convert("RGB"), name)
    total = _video_frame_count(path)
    if total:
        meta["frames"] = total
    return meta


def _probe_audio(path: str) -> dict:
    try:
        data, sr = _audio_array(path)
        if data is None or not sr:
            return {}
        n = int(data.shape[1])
        return {"duration": round(n / sr, 2), "frames": n, "sample_rate": sr}
    except Exception as exc:
        print(f"[BatchMediaHub] 音频探测失败 {os.path.basename(path)}：{exc}")
        return {}


def _audio_array(path: str):
    """用 PyAV 解码成 float32 浮点：返回 (channels,numpy[n]), sample_rate。

    torchaudio 2.9 的 load 需要 torchcodec，很多整合包没装，所以优先走 PyAV。
    """
    import numpy as np

    try:
        import av
    except Exception:
        av = None

    if av is not None:
        with av.open(path) as c:
            stream = c.streams.audio[0]
            sr = int(stream.rate or 0)
            layout = stream.layout.name if stream.layout is not None else "mono"
            resampler = av.AudioResampler(format="fltp", layout=layout, rate=sr or 44100)
            chunks = []
            for frame in c.decode(stream):
                for rf in resampler.resample(frame):
                    chunks.append(rf.to_ndarray().astype(np.float32))
            for rf in resampler.resample(None):
                chunks.append(rf.to_ndarray().astype(np.float32))
        if chunks:
            data = np.concatenate(chunks, axis=1)
            if data.shape[0] > 2:  # 只留前两声道
                data = data[:2]
            return data, sr or 44100

    import torchaudio  # 兜底：老版本 torchaudio 还能用

    wav, sr = torchaudio.load(path)
    return wav.numpy(), int(sr)


def _save_thumb(im, name: str) -> str:
    _ensure_dirs()
    im = im.copy()
    im.thumbnail((256, 256))
    thumb_name = os.path.splitext(name)[0] + ".jpg"
    im.save(os.path.join(_thumb_dir(), thumb_name), "JPEG", quality=84)
    return thumb_name


def _video_frame_count(path: str) -> int | None:
    try:
        import av

        with av.open(path) as c:
            st = c.streams.video[0]
            if st.frames:
                return int(st.frames)
            return None
    except Exception:
        pass
    try:
        import cv2

        cap = cv2.VideoCapture(path)
        n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        cap.release()
        return n or None
    except Exception:
        return None


def _decode_video(path: str, limit: int = 121, strict: bool = True):
    """优先 PyAV，退到 OpenCV；返回 uint8 [N,H,W,3] RGB。"""
    import numpy as np

    problems = []
    try:
        import av

        with av.open(path) as c:
            stream = c.streams.video[0]
            stream.thread_type = "AUTO"
            frames = []
            for frame in c.decode(stream):
                frames.append(frame.to_ndarray(format="rgb24"))
                if len(frames) >= limit:
                    break
        if frames:
            return np.stack(frames)
        problems.append("PyAV 未解出帧")
    except Exception as exc:
        problems.append(f"PyAV: {exc}")

    try:
        import cv2

        cap = cv2.VideoCapture(path)
        frames = []
        while len(frames) < limit:
            ok, bgr = cap.read()
            if not ok:
                break
            frames.append(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
        cap.release()
        if frames:
            return np.stack(frames)
        problems.append("OpenCV 未解出帧")
    except Exception as exc:
        problems.append(f"OpenCV: {exc}")

    if strict:
        raise RuntimeError("视频解码失败（请安装 PyAV 或 opencv-python）：" + "；".join(problems))
    return None


# --------------------------------------------------------------------------- 上传接口


async def _handle_upload(request: web.Request):
    if not request.content_type.startswith("multipart/"):
        return web.json_response({"ok": False, "error": "需要 multipart/form-data"}, status=400)

    reader = await request.multipart()
    saved: list[dict] = []
    skipped: list[str] = []

    while True:
        part = await reader.next()
        if part is None:
            break
        if part.name not in ("files", "file", "images"):
            continue

        filename = _safe_name(part.filename or "")
        if not filename:
            skipped.append("(空文件名)")
            continue
        kind = _kind_of(filename)
        if kind is None:
            skipped.append(filename)
            continue

        dest = _unique_path(filename)
        total = 0
        with open(dest, "wb") as fh:
            while True:
                chunk = await part.read_chunk(2 ** 20)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    fh.close()
                    os.remove(dest)
                    return web.json_response(
                        {"ok": False, "error": f"{filename} 超过 1GB 上限"}, status=413
                    )
                fh.write(chunk)

        saved.append(_probe(dest, kind, os.path.basename(dest)))

    return web.json_response({"ok": True, "files": saved, "skipped": skipped})


def _register_routes() -> None:
    inst = getattr(PromptServer, "instance", None)
    routes = getattr(inst, "routes", None) if inst is not None else None
    if routes is None:
        print("[BatchMediaHub] 警告：PromptServer 未就绪，上传路由未注册")
        return
    routes.post("/batch_media/upload")(_handle_upload)


_register_routes()


# --------------------------------------------------------------------------- 状态解析


def _default_state() -> dict:
    return {
        "v": 1,
        "max_video_frames": 121,
        "slots": {k: [{"file": None, "on": True} for _ in range(n)] for k, n in SLOT_COUNTS.items()},
    }


def _parse_state(state) -> dict:
    if isinstance(state, dict):
        raw = state
    else:
        try:
            raw = json.loads(state or "{}")
        except Exception:
            raw = {}
    if not isinstance(raw, dict):
        raw = {}

    out = _default_state()
    try:
        out["max_video_frames"] = max(1, min(900, int(raw.get("max_video_frames", 121))))
    except Exception:
        out["max_video_frames"] = 121
    slots_raw = raw.get("slots") if isinstance(raw.get("slots"), dict) else {}
    for kind, count in SLOT_COUNTS.items():
        given = slots_raw.get(kind)
        if not isinstance(given, list):
            continue
        for i in range(min(count, len(given))):
            cell = given[i]
            if not isinstance(cell, dict):
                continue
            fname = cell.get("file")
            out["slots"][kind][i] = {
                "file": _safe_name(fname) if fname else None,
                "on": bool(cell.get("on", True)),
                "thumb": cell.get("thumb"),
                "meta": cell.get("meta") or {},
            }
    return out


# --------------------------------------------------------------------------- 读取素材


def _resolve(name: str) -> str | None:
    base = _safe_name(name)
    if not base:
        return None
    path = os.path.join(_store_dir(), base)
    return path if os.path.isfile(path) else None


def _load_image(name: str):
    import numpy as np
    import torch
    from PIL import Image, ImageOps

    path = _resolve(name)
    if not path:
        print(f"[BatchMediaHub] 图片不存在，已跳过：{name}")
        return None
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im).convert("RGB")
        arr = np.asarray(im).astype(np.float32) / 255.0
    return torch.from_numpy(arr)[None, ...]


def _load_audio(name: str):
    import torch

    path = _resolve(name)
    if not path:
        print(f"[BatchMediaHub] 音频不存在，已跳过：{name}")
        return None
    try:
        data, sr = _audio_array(path)
    except Exception as exc:
        print(f"[BatchMediaHub] 音频读取失败 {name}：{exc}")
        return None
    if data is None or data.size == 0:
        print(f"[BatchMediaHub] 音频为空，已跳过：{name}")
        return None
    return {"waveform": torch.from_numpy(data)[None, ...].float(), "sample_rate": int(sr)}


def _load_video(name: str, limit: int = 121):
    import numpy as np
    import torch

    path = _resolve(name)
    if not path:
        print(f"[BatchMediaHub] 视频不存在，已跳过：{name}")
        return None
    try:
        frames = _decode_video(path, limit=max(1, int(limit)))
    except Exception as exc:
        print(f"[BatchMediaHub] 视频读取失败 {name}：{exc}")
        return None
    if frames is None or not len(frames):
        return None
    return torch.from_numpy(frames.astype(np.float32) / 255.0)


# --------------------------------------------------------------------------- 节点


class BatchMediaHub:
    """9 图 / 3 视频 / 3 音频 的批量上传与开关。"""

    CATEGORY = "Batch/素材"
    FUNCTION = "run"

    RETURN_TYPES = ("IMAGE",) * 9 + ("IMAGE",) * 3 + ("AUDIO",) * 3
    RETURN_NAMES = (
        "图1", "图2", "图3", "图4", "图5", "图6", "图7", "图8", "图9",
        "视频1", "视频2", "视频3",
        "音频1", "音频2", "音频3",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 前端用 JSON 记录每个格子的文件名 / 开关 / 视频帧上限，随工作流保存
                "state": ("STRING", {"default": "{}", "multiline": True}),
            }
        }

    def run(self, state=None):
        slots = _parse_state(state)
        limit = slots.get("max_video_frames", 121)
        try:
            limit = max(1, min(900, int(limit)))
        except Exception:
            limit = 121
        outputs = []

        for i in range(SLOT_COUNTS["image"]):
            slot = slots["slots"]["image"][i]
            if not slot.get("on") or not slot.get("file"):
                outputs.append(None)
            else:
                outputs.append(_load_image(slot["file"]))

        for i in range(SLOT_COUNTS["video"]):
            slot = slots["slots"]["video"][i]
            if not slot.get("on") or not slot.get("file"):
                outputs.append(None)
            else:
                outputs.append(_load_video(slot["file"], limit=limit))

        for i in range(SLOT_COUNTS["audio"]):
            slot = slots["slots"]["audio"][i]
            if not slot.get("on") or not slot.get("file"):
                outputs.append(None)
            else:
                outputs.append(_load_audio(slot["file"]))

        return tuple(outputs)

    @classmethod
    def IS_CHANGED(cls, state=None, **kwargs):
        """素材文件名 / 开关 / 帧数上限 / 文件修改时间变化时重跑，其它时候命中缓存。"""
        digest = hashlib.sha256(str(state or "").encode("utf-8")).hexdigest()[:16]
        frames = _parse_state(state).get("max_video_frames", 121)
        stamps = []
        slots = _parse_state(state)
        for kind in SLOT_COUNTS:
            for slot in slots["slots"][kind]:
                if not slot.get("on") or not slot.get("file"):
                    continue
                path = _resolve(slot["file"])
                stamps.append(f"{slot['file']}:{os.path.getmtime(path):.3f}" if path else f"{slot['file']}:missing")
        return f"{digest}|{frames}|{';'.join(stamps)}"


NODE_CLASS_MAPPINGS = {NODE_NAME: BatchMediaHub}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_NAME: "批量素材中心（9图/3视频/3音频）"}
