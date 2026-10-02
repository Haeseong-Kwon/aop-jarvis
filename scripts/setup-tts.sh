#!/usr/bin/env bash
# Installs the AOP voice engine: Qwen3-TTS on MLX (Apple Silicon) in a private venv, plus the sidecar.
#   scripts/setup-tts.sh            # CINEMATIC/BALANCED (1.7B Base) + VoiceDesign (for creating the voice)
#   scripts/setup-tts.sh --fast     # also the 0.6B model for FAST mode
# Disk: ~4.5 GB per 1.7B bf16 model, ~1.8 GB for 0.6B. Models land in the Hugging Face cache (~/.cache/huggingface).
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "Qwen3-TTS via MLX needs macOS on Apple Silicon. JARVIS will keep using macOS speech." >&2
  exit 1
fi

SUPPORT="$HOME/Library/Application Support/aop-jarvis"
VENV="$SUPPORT/tts-venv"
DEST="$SUPPORT/tts"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
MLX_AUDIO_VERSION="0.5.7"

PY="$(command -v python3.12 || command -v python3.11 || command -v python3 || true)"
[[ -z "$PY" ]] && { echo "python3 (3.10+) is required: brew install python@3.12" >&2; exit 1; }
"$PY" -c 'import sys; assert sys.version_info >= (3, 10), sys.version' || { echo "python 3.10+ required" >&2; exit 1; }

mkdir -p "$SUPPORT"
if command -v uv >/dev/null; then
  # uv provides a pinned 3.12 (mlx-audio wheels target 3.10–3.13) and seeds pip, so installs don't depend on `uv pip`.
  uv venv --seed --python 3.12 "$VENV"
  "$VENV/bin/python" -m pip install "mlx-audio==$MLX_AUDIO_VERSION" numpy soundfile
else
  "$PY" -m venv "$VENV"
  "$VENV/bin/pip" install --upgrade pip
  "$VENV/bin/pip" install "mlx-audio==$MLX_AUDIO_VERSION" numpy soundfile
fi

# Sidecar + voice profiles (reference clips created later by Voice Lab / audition are kept across updates).
mkdir -p "$DEST/voices"
rsync -a --exclude 'voices/*.wav' --exclude '__pycache__' "$HERE/services/tts/" "$DEST/"

MODELS=(mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16 mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16)
[[ "${1:-}" == "--fast" ]] && MODELS+=(mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16)
for m in "${MODELS[@]}"; do
  echo "→ downloading $m"
  "$VENV/bin/python" -c "from huggingface_hub import snapshot_download; snapshot_download('$m')"
done

echo
echo "Installed. Next:"
echo "  1. Create the voice candidates (VoiceDesign → locked reference clips) and listen:"
echo "       \"$VENV/bin/python\" \"$DEST/audition.py\" --design --out ~/Desktop/aop-voice-audition"
echo "  2. Open ~/Desktop/aop-voice-audition/index.html, pick a default, set it in Settings › Voice (or Voice Lab)."
