"""Local TTS engines for AOP.

Qwen3Engine wraps mlx-audio's Qwen3-TTS (Apple Silicon / MLX). It keeps models resident, streams PCM as it is
generated, and implements the AOP voice-identity workflow:

    VoiceDesign (1.7B)  --describe-->  reference clip (one per candidate, saved once, versioned)
    Base (1.7B / 0.6B)  --clone (ICL or x-vector)-->  every utterance in that fixed identity

VoiceDesign alone samples a *new* voice for every call, so it cannot be used directly for a stable persona;
it is only used to *create* the reference. Runtime speech always uses the Base model locked to that clip.

DummyEngine exists only to test the HTTP/streaming protocol on machines without MLX. It emits a synthetic
vowel-like signal, never speech, and reports itself as such.
"""

from __future__ import annotations

import gc
import json
import math
import os
import resource
import threading
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable, Iterator, Optional

SAMPLE_RATE = 24_000

LANG = {"ko": "korean", "en": "english", "auto": "auto"}

# Model ids per quality mode. Base models do the speaking; VoiceDesign only creates reference clips.
MODELS = {
    "CINEMATIC": {"base": "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16", "clone": "icl"},
    "BALANCED": {"base": "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16", "clone": "xvector"},
    "FAST": {"base": "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16", "clone": "xvector"},
}
DESIGN_MODEL = "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16"


@dataclass
class Profile:
    id: str
    name: str
    instruct: str
    ref_text: str
    ref_lang: str = "ko"
    seed: int = 7
    temperature: float = 0.7
    top_p: float = 0.9
    repetition_penalty: float = 1.05
    notes: str = ""


@dataclass
class Metrics:
    id: str
    engine: str
    model: str
    profile: str
    mode: str
    chars: int
    first_chunk_ms: Optional[float] = None
    total_ms: float = 0.0
    audio_s: float = 0.0
    rtf: Optional[float] = None
    peak_mem_mb: Optional[float] = None
    rss_mb: float = 0.0
    cancelled: bool = False
    error: Optional[str] = None
    cached_ref: bool = False
    extra: dict = field(default_factory=dict)


def rss_mb() -> float:
    # ru_maxrss is bytes on macOS, KiB on Linux.
    r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return r / (1024 * 1024) if os.uname().sysname == "Darwin" else r / 1024


def load_profiles(path: Path) -> dict[str, Profile]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return {p["id"]: Profile(**{k: v for k, v in p.items() if k in Profile.__dataclass_fields__}) for p in data["candidates"]}


class Cancelled(Exception):
    pass


class Engine:
    name = "base"

    def info(self) -> dict:
        raise NotImplementedError

    def synthesize(self, req_id: str, text: str, lang: str, profile: Profile, mode: str, chunk_s: float, is_cancelled: Callable[[], bool]) -> Iterator[bytes]:
        raise NotImplementedError

    def design(self, profile: Profile, out_wav: Path) -> dict:
        raise NotImplementedError

    def unload(self) -> None:
        pass


def to_pcm16(samples) -> bytes:
    """float array in [-1, 1] → little-endian int16 bytes (numpy if available)."""
    try:
        import numpy as np

        a = np.asarray(samples, dtype=np.float32).reshape(-1)
        return (np.clip(a, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
    except ImportError:  # pragma: no cover - numpy ships with mlx
        import struct

        return b"".join(struct.pack("<h", int(max(-1.0, min(1.0, float(s))) * 32767)) for s in samples)


def write_wav(path: Path, pcm16: bytes, sr: int = SAMPLE_RATE) -> None:
    import wave

    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm16)


class Qwen3Engine(Engine):
    """mlx-audio Qwen3-TTS. One inference at a time (MLX is not used concurrently); models stay resident."""

    name = "qwen3-mlx"

    def __init__(self, voices_dir: Path):
        self.voices_dir = voices_dir
        self._models: dict[str, object] = {}
        self._lock = threading.Lock()
        self._ref_cache: dict[str, object] = {}

    def _model(self, model_id: str):
        if model_id not in self._models:
            from mlx_audio.tts.utils import load_model  # imported lazily: heavy

            t = time.perf_counter()
            self._models[model_id] = load_model(model_id)
            print(json.dumps({"event": "model_loaded", "model": model_id, "ms": round((time.perf_counter() - t) * 1000)}), flush=True)
        return self._models[model_id]

    def loaded(self) -> list[str]:
        return list(self._models)

    def info(self) -> dict:
        mem = {}
        try:
            import mlx.core as mx

            mem = {"mlx_active_mb": round(mx.get_active_memory() / 2**20, 1), "mlx_peak_mb": round(mx.get_peak_memory() / 2**20, 1)}
        except Exception:  # noqa: BLE001
            pass
        return {"engine": self.name, "loaded": self.loaded(), "rss_mb": round(rss_mb(), 1), **mem}

    def ref_path(self, profile: Profile) -> Path:
        return self.voices_dir / f"{profile.id}.wav"

    def warmup(self, mode: str) -> None:
        self._model(MODELS[mode]["base"])

    def design(self, profile: Profile, out_wav: Path) -> dict:
        """Create the identity reference clip with VoiceDesign (deterministic seed)."""
        import mlx.core as mx

        with self._lock:
            model = self._model(DESIGN_MODEL)
            mx.random.seed(profile.seed)
            t = time.perf_counter()
            chunks = []
            for r in model.generate(text=profile.ref_text, instruct=profile.instruct, lang_code=LANG.get(profile.ref_lang, "auto"), temperature=profile.temperature, top_p=profile.top_p, repetition_penalty=profile.repetition_penalty):
                chunks.append(to_pcm16(r.audio))
            pcm = b"".join(chunks)
            write_wav(out_wav, pcm)
            self._ref_cache.pop(profile.id, None)
            return {"ms": round((time.perf_counter() - t) * 1000), "audio_s": len(pcm) / 2 / SAMPLE_RATE, "path": str(out_wav)}

    def synthesize(self, req_id, text, lang, profile, mode, chunk_s, is_cancelled):
        import mlx.core as mx

        cfg = MODELS[mode]
        ref = self.ref_path(profile)
        if not ref.exists():
            raise FileNotFoundError(f"voice '{profile.id}' has no reference clip yet — run design first ({ref})")
        with self._lock:
            model = self._model(cfg["base"])
            mx.random.seed(profile.seed)
            kwargs = dict(
                text=text,
                lang_code=LANG.get(lang, "auto"),
                ref_audio=str(ref),
                temperature=profile.temperature,
                top_p=profile.top_p,
                repetition_penalty=profile.repetition_penalty,
                stream=True,
                streaming_interval=chunk_s,
                split_pattern="",
            )
            if cfg["clone"] == "icl":
                kwargs["ref_text"] = profile.ref_text
            for r in model.generate(**kwargs):
                if is_cancelled():
                    raise Cancelled()
                yield to_pcm16(r.audio)

    def unload(self) -> None:
        with self._lock:
            self._models.clear()
            self._ref_cache.clear()
            gc.collect()
            try:
                import mlx.core as mx

                mx.clear_cache()
            except Exception:  # noqa: BLE001
                pass


class DummyEngine(Engine):
    """Protocol test engine: a vowel-like synthetic signal with syllable envelope. NOT speech."""

    name = "dummy"

    def __init__(self, voices_dir: Path, realtime_factor: float = 0.25, first_chunk_ms: float = 120):
        self.voices_dir = voices_dir
        self.rtf = realtime_factor
        self.first = first_chunk_ms / 1000

    def ref_path(self, profile: Profile) -> Path:
        return self.voices_dir / f"{profile.id}.wav"

    def info(self) -> dict:
        return {"engine": self.name, "loaded": ["dummy"], "rss_mb": round(rss_mb(), 1), "note": "synthetic signal for protocol tests, not speech"}

    def design(self, profile, out_wav):
        pcm = b"".join(self._signal(1.5))
        write_wav(out_wav, pcm)
        return {"ms": 0, "audio_s": 1.5, "path": str(out_wav)}

    def _signal(self, seconds: float, chunk_s: float = 0.32) -> Iterator[bytes]:
        n = int(seconds * SAMPLE_RATE)
        step = int(chunk_s * SAMPLE_RATE)
        for start in range(0, n, step):
            out = []
            for i in range(start, min(n, start + step)):
                t = i / SAMPLE_RATE
                env = max(0.0, math.sin(2 * math.pi * 4.2 * t)) ** 0.7
                f0 = 110 + 8 * math.sin(2 * math.pi * 0.7 * t)
                s = sum(math.sin(2 * math.pi * f0 * k * t) / k for k in range(1, 6))
                out.append(0.12 * env * s)
            yield to_pcm16(out)

    def synthesize(self, req_id, text, lang, profile, mode, chunk_s, is_cancelled):
        seconds = max(0.6, len(text) * (0.11 if lang == "ko" else 0.065))
        time.sleep(self.first)
        for chunk in self._signal(seconds, chunk_s):
            if is_cancelled():
                raise Cancelled()
            time.sleep(chunk_s * self.rtf)
            yield chunk


def metrics_dict(m: Metrics) -> dict:
    return asdict(m)
