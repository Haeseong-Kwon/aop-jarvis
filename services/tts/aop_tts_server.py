#!/usr/bin/env python3
"""AOP TTS sidecar — local HTTP server on 127.0.0.1 that streams speech as raw PCM.

Protocol (all JSON bodies):
  GET  /health                      → {ok, engine, loaded, rss_mb, mlx_active_mb?, mlx_peak_mb?, sample_rate, profiles}
  POST /synthesize {id, text, lang, profile, mode, chunk_s}
                                    → 200, Transfer-Encoding: chunked, application/octet-stream
                                      body = mono int16 LE PCM at X-Sample-Rate, flushed per generated chunk
  POST /cancel {id}                 → stops that synthesis at the next chunk boundary
  GET  /metrics?id=…                → latency / RTF / memory for a finished request (last 64 kept)
  GET  /profiles                    → voice candidates and whether each has a reference clip
  POST /design {profile}            → creates the candidate's reference clip with VoiceDesign
  POST /design {profile:"lab", instruct, seed?, ref_text?}
                                    → Voice Lab: designs an ad-hoc candidate (kept in memory as "lab")
  POST /profiles/save {id, name, notes?}
                                    → promotes the current "lab" design to a saved candidate (JSON + clip)
  GET  /voice?profile=…             → the stored reference clip (WAV)
  POST /warmup {mode}               → load the Base model for a quality mode (keeps it resident)
  POST /unload                      → release models (also done automatically after --idle-unload-min)

The server is single-inference (MLX is used from one thread at a time); requests queue on the engine lock.
It binds to 127.0.0.1 only. Run: python3 aop_tts_server.py --port 47821 [--engine dummy]
"""

from __future__ import annotations

import argparse
import json
import os
import threading
import time
import traceback
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import shutil
from dataclasses import asdict, replace

from aop_tts.engine import SAMPLE_RATE, Cancelled, DummyEngine, Engine, Metrics, Profile, Qwen3Engine, load_profiles, metrics_dict, rss_mb

HERE = Path(__file__).resolve().parent


class State:
    def __init__(self, engine: Engine, profiles_path: Path, idle_unload_s: float):
        self.engine = engine
        self.profiles_path = profiles_path
        self.cancelled: set[str] = set()
        self.metrics: OrderedDict[str, dict] = OrderedDict()
        self.last_use = time.time()
        self.idle_unload_s = idle_unload_s
        self.lock = threading.Lock()
        self.lab: Profile | None = None

    def profiles(self):
        out = load_profiles(self.profiles_path)
        if self.lab:
            out["lab"] = self.lab
        return out

    def ref_path(self, p: Profile) -> Path:
        return self.engine.ref_path(p) if hasattr(self.engine, "ref_path") else HERE / "voices" / f"{p.id}.wav"

    def record(self, m: Metrics) -> None:
        with self.lock:
            self.metrics[m.id] = metrics_dict(m)
            while len(self.metrics) > 64:
                self.metrics.popitem(last=False)


def make_handler(state: State):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # quiet; structured events go to stdout instead
            pass

        def _cors(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "content-type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Expose-Headers", "X-Sample-Rate, X-Request-Id")

        def _json(self, code: int, obj) -> None:
            body = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(code)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _body(self) -> dict:
            n = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(n) or b"{}") if n else {}

        def do_OPTIONS(self):
            self.send_response(204)
            self._cors()
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self):
            url = urlparse(self.path)
            q = parse_qs(url.query)
            if url.path == "/health":
                profiles = state.profiles()
                return self._json(200, {"ok": True, "sample_rate": SAMPLE_RATE, **state.engine.info(), "profiles": list(profiles)})
            if url.path == "/metrics":
                rid = (q.get("id") or [""])[0]
                with state.lock:
                    m = state.metrics.get(rid) if rid else list(state.metrics.values())[-16:]
                return self._json(200 if m is not None else 404, m or {"error": "unknown id"})
            if url.path == "/profiles":
                out = []
                for p in state.profiles().values():
                    ref = state.ref_path(p)
                    out.append({"id": p.id, "name": p.name, "instruct": p.instruct, "notes": p.notes, "seed": p.seed, "hasReference": bool(ref and ref.exists())})
                return self._json(200, out)
            if url.path == "/voice":
                p = state.profiles().get((q.get("profile") or [""])[0])
                ref = state.ref_path(p) if p else None
                if not ref or not ref.exists():
                    return self._json(404, {"error": "no reference clip"})
                data = ref.read_bytes()
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            return self._json(404, {"error": "not found"})

        def do_POST(self):
            url = urlparse(self.path)
            try:
                body = self._body()
            except json.JSONDecodeError:
                return self._json(400, {"error": "invalid json"})
            state.last_use = time.time()
            if url.path == "/synthesize":
                return self._synthesize(body)
            if url.path == "/cancel":
                state.cancelled.add(str(body.get("id", "")))
                return self._json(200, {"ok": True})
            if url.path == "/warmup":
                try:
                    if hasattr(state.engine, "warmup"):
                        t = time.perf_counter()
                        state.engine.warmup(body.get("mode", "CINEMATIC"))
                        return self._json(200, {"ok": True, "ms": round((time.perf_counter() - t) * 1000), **state.engine.info()})
                    return self._json(200, {"ok": True, **state.engine.info()})
                except Exception as e:  # noqa: BLE001
                    return self._json(500, {"error": str(e)})
            if url.path == "/unload":
                state.engine.unload()
                return self._json(200, {"ok": True, **state.engine.info()})
            if url.path == "/design":
                profiles = state.profiles()
                if body.get("profile") == "lab":
                    base = profiles.get(str(body.get("base", ""))) or next(iter(load_profiles(state.profiles_path).values()))
                    state.lab = replace(
                        base,
                        id="lab",
                        name="Voice Lab design",
                        instruct=str(body.get("instruct") or base.instruct),
                        seed=int(body.get("seed", base.seed)),
                        ref_text=str(body.get("ref_text") or base.ref_text),
                        notes="unsaved",
                    )
                    p = state.lab
                else:
                    p = profiles.get(str(body.get("profile", "")))
                if not p:
                    return self._json(404, {"error": "unknown profile"})
                try:
                    info = state.engine.design(p, state.ref_path(p))
                    return self._json(200, {"ok": True, "profile": p.id, **info})
                except Exception as e:  # noqa: BLE001
                    traceback.print_exc()
                    return self._json(500, {"error": str(e)})
            if url.path == "/profiles/save":
                if not state.lab or not state.ref_path(state.lab).exists():
                    return self._json(400, {"error": "design a lab voice first"})
                new_id = str(body.get("id", "")).strip()
                if not new_id or not new_id.replace("-", "").isalnum():
                    return self._json(400, {"error": "id must be alphanumeric/dashes"})
                data = json.loads(state.profiles_path.read_text(encoding="utf-8"))
                if any(c["id"] == new_id for c in data["candidates"]):
                    return self._json(409, {"error": "id exists"})
                saved = replace(state.lab, id=new_id, name=str(body.get("name") or new_id), notes=str(body.get("notes", "")))
                shutil.copy(state.ref_path(state.lab), state.ref_path(saved))
                data["candidates"].append(asdict(saved))
                state.profiles_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
                return self._json(200, {"ok": True, "id": new_id})
            return self._json(404, {"error": "not found"})

        def _synthesize(self, body: dict) -> None:
            rid = str(body.get("id") or f"r{time.time_ns()}")
            text = str(body.get("text", "")).strip()
            lang = str(body.get("lang", "auto"))
            mode = str(body.get("mode", "CINEMATIC")).upper()
            chunk_s = float(body.get("chunk_s", 0.32))
            profiles = state.profiles()
            profile = profiles.get(str(body.get("profile", ""))) or next(iter(profiles.values()))
            m = Metrics(id=rid, engine=state.engine.name, model=mode, profile=profile.id, mode=mode, chars=len(text))
            if not text:
                return self._json(400, {"error": "empty text"})
            t0 = time.perf_counter()
            samples = 0
            started = False
            try:
                for pcm in state.engine.synthesize(rid, text, lang, profile, mode, chunk_s, lambda: rid in state.cancelled):
                    if not started:
                        m.first_chunk_ms = round((time.perf_counter() - t0) * 1000, 1)
                        self.send_response(200)
                        self._cors()
                        self.send_header("Content-Type", "application/octet-stream")
                        self.send_header("Transfer-Encoding", "chunked")
                        self.send_header("X-Sample-Rate", str(SAMPLE_RATE))
                        self.send_header("X-Request-Id", rid)
                        self.end_headers()
                        started = True
                    samples += len(pcm) // 2
                    self.wfile.write(f"{len(pcm):X}\r\n".encode() + pcm + b"\r\n")
                    self.wfile.flush()
                if started:
                    self.wfile.write(b"0\r\n\r\n")
                    self.wfile.flush()
                else:
                    return self._json(500, {"error": "engine produced no audio"})
            except Cancelled:
                m.cancelled = True
                if started:
                    self.wfile.write(b"0\r\n\r\n")
            except (BrokenPipeError, ConnectionResetError):
                m.cancelled = True  # client went away (barge-in) — stop generating
            except Exception as e:  # noqa: BLE001
                traceback.print_exc()
                m.error = str(e)
                if not started:
                    return self._json(500, {"error": str(e)})
            finally:
                state.cancelled.discard(rid)
                m.total_ms = round((time.perf_counter() - t0) * 1000, 1)
                m.audio_s = round(samples / SAMPLE_RATE, 3)
                m.rtf = round((m.total_ms / 1000) / m.audio_s, 3) if m.audio_s else None
                m.rss_mb = round(rss_mb(), 1)
                info = state.engine.info()
                m.peak_mem_mb = info.get("mlx_peak_mb")
                state.record(m)
                print(json.dumps({"event": "synth", **metrics_dict(m)}, ensure_ascii=False), flush=True)

    return Handler


def idle_reaper(state: State) -> None:
    while True:
        time.sleep(30)
        if state.idle_unload_s > 0 and time.time() - state.last_use > state.idle_unload_s and getattr(state.engine, "loaded", lambda: [])():
            state.engine.unload()
            print(json.dumps({"event": "idle_unload"}), flush=True)


def exit_with_parent(poll_s: float = 2.0) -> None:
    """The app spawns this sidecar; macOS app quit skips child cleanup, so stop when the parent is gone
    (reparented to launchd). Covers normal quit, crash and force-quit — the model holds ~4.5 GB."""
    parent = os.getppid()
    if parent <= 1:
        return  # started by hand (setup, audition): no parent to follow

    def watch() -> None:
        while True:
            time.sleep(poll_s)
            if os.getppid() != parent:
                os._exit(0)

    threading.Thread(target=watch, name="parent-watch", daemon=True).start()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=47821)
    ap.add_argument("--engine", choices=["qwen3", "dummy"], default="qwen3")
    ap.add_argument("--profiles", type=Path, default=HERE / "voices" / "aop-core.json")
    ap.add_argument("--voices-dir", type=Path, default=HERE / "voices")
    ap.add_argument("--warm", default="", help="quality mode to load at start (CINEMATIC/BALANCED/FAST)")
    ap.add_argument("--idle-unload-min", type=float, default=30)
    args = ap.parse_args()
    exit_with_parent()

    engine: Engine = DummyEngine(args.voices_dir) if args.engine == "dummy" else Qwen3Engine(args.voices_dir)
    state = State(engine, args.profiles, args.idle_unload_min * 60)
    if args.warm and hasattr(engine, "warmup"):
        engine.warmup(args.warm.upper())
    threading.Thread(target=idle_reaper, args=(state,), daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(state))
    print(json.dumps({"event": "listening", "port": args.port, "engine": engine.name}), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
