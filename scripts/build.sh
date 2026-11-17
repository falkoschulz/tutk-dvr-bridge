#!/usr/bin/env bash
set -euo pipefail

# Build tutk-dvr-bridge Docker image (default) or local native binary (--native).
#
# Usage:
#   ./scripts/build.sh                  # Build Docker image tutk-dvr-bridge:latest
#   IMAGE_TAG=myrepo/tutk-dvr-bridge:1.0 ./scripts/build.sh
#   ./scripts/build.sh --native         # Build TypeScript + native/tutk_helper locally

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NATIVE_DIR="$ROOT_DIR/native"
IMAGE_TAG="${IMAGE_TAG:-tutk-dvr-bridge:latest}"

check_tutk_files() {
  local missing=0
  for f in \
    "$NATIVE_DIR/libIOTCAPIs_ALL.so" \
    "$NATIVE_DIR/include/IOTCAPIs.h" \
    "$NATIVE_DIR/include/AVAPIs.h"
  do
    if [[ ! -f "$f" ]]; then
      echo "Missing required TUTK SDK file: $f" >&2
      missing=1
    fi
  done

  if [[ "$missing" -ne 0 ]]; then
    echo "" >&2
    echo "Please obtain the ThroughTek (TUTK) IOTC SDK and run:" >&2
    echo "  ./scripts/setup-tutk.sh /path/to/TUTK_IOTC_Platform_*.zip" >&2
    echo "See README.md for details." >&2
    exit 1
  fi
}

check_tutk_files

cd "$ROOT_DIR"

if [[ "${1:-}" == "--native" ]]; then
  echo "Building TypeScript..."
  npm ci
  npm run build

  echo "Compiling native/tutk_helper..."
  gcc -O2 -Wall -Inative/include native/tutk_helper.c \
    -Lnative -l:libIOTCAPIs_ALL.so -lpthread -Wl,-rpath,'$ORIGIN' \
    -o native/tutk_helper

  echo "Native build complete."
else
  echo "Building Docker image: $IMAGE_TAG"
  docker build -t "$IMAGE_TAG" .
  echo "Docker build complete: $IMAGE_TAG"
fi
