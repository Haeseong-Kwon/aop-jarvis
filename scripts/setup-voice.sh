#!/usr/bin/env bash
# Installs the local speech-to-text engine (whisper.cpp) and one multilingual model.
# Usage: scripts/setup-voice.sh [model]   (default: small-q5_1 — good Korean/English at low latency)
set -euo pipefail
MODEL="${1:-small-q5_1}"
DIR="$HOME/Library/Application Support/aop-jarvis/models"
mkdir -p "$DIR"

if ! command -v whisper-cli >/dev/null 2>&1; then
  command -v brew >/dev/null || { echo "Homebrew is required: https://brew.sh" >&2; exit 1; }
  brew install whisper-cpp
fi

FILE="$DIR/ggml-$MODEL.bin"
if [ ! -s "$FILE" ]; then
  curl -fL --progress-bar -o "$FILE.part" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$MODEL.bin"
  mv "$FILE.part" "$FILE"
fi
echo "whisper-cli: $(command -v whisper-cli)"
echo "model:       $FILE"
