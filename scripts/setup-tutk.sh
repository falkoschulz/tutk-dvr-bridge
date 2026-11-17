#!/usr/bin/env bash
set -euo pipefail

# Populate native/include/ and build native/libIOTCAPIs_ALL.so from a
# ThroughTek (TUTK) IOTC SDK archive (.zip) or extracted directory.
#
# Usage:
#   ./scripts/setup-tutk.sh /path/to/TUTK_IOTC_Platform_14W42P1.zip
#   ./scripts/setup-tutk.sh /path/to/extracted_tutk_sdk_dir

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NATIVE_DIR="$ROOT_DIR/native"
INCLUDE_DIR="$NATIVE_DIR/include"

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <path-to-tutk-sdk-zip-or-dir>" >&2
  exit 1
fi

INPUT="$1"
TMP_DIR=""
cleanup() {
  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

if [[ -f "$INPUT" ]]; then
  if ! command -v unzip >/dev/null 2>&1; then
    echo "ERROR: 'unzip' is required to extract $INPUT" >&2
    exit 1
  fi
  TMP_DIR="$(mktemp -d)"
  echo "Extracting $INPUT..."
  unzip -q "$INPUT" -d "$TMP_DIR"
  SDK_ROOT="$TMP_DIR"
elif [[ -d "$INPUT" ]]; then
  SDK_ROOT="$INPUT"
else
  echo "ERROR: '$INPUT' is not a file or directory." >&2
  exit 1
fi

if ! command -v g++ >/dev/null 2>&1; then
  echo "ERROR: 'g++' is required to link libIOTCAPIs_ALL.so" >&2
  exit 1
fi

IOTC_H="$(find "$SDK_ROOT" -type f -name 'IOTCAPIs.h' | head -n 1 || true)"
AV_H="$(find "$SDK_ROOT" -type f -name 'AVAPIs.h' | head -n 1 || true)"
LIB_IOTC="$(find "$SDK_ROOT" -type f -path '*/Linux/x64/libIOTCAPIs.a' | head -n 1 || true)"
LIB_AV="$(find "$SDK_ROOT" -type f -path '*/Linux/x64/libAVAPIs.a' | head -n 1 || true)"

if [[ -z "$IOTC_H" || -z "$AV_H" ]]; then
  echo "ERROR: Could not find IOTCAPIs.h and AVAPIs.h under $SDK_ROOT" >&2
  exit 1
fi

if [[ -z "$LIB_IOTC" || -z "$LIB_AV" ]]; then
  echo "ERROR: Could not find Linux/x64/libIOTCAPIs.a and libAVAPIs.a under $SDK_ROOT" >&2
  exit 1
fi

HDR_SRC_DIR="$(dirname "$IOTC_H")"
mkdir -p "$INCLUDE_DIR"
cp "$HDR_SRC_DIR"/*.h "$INCLUDE_DIR/"
echo "Copied TUTK headers to $INCLUDE_DIR/"

echo "Building $NATIVE_DIR/libIOTCAPIs_ALL.so..."
g++ -fpic -shared -Wl,--whole-archive "$LIB_AV" "$LIB_IOTC" -Wl,--no-whole-archive \
  -lpthread -o "$NATIVE_DIR/libIOTCAPIs_ALL.so"

echo "Done. Proprietary TUTK SDK files are ready in $NATIVE_DIR/"
