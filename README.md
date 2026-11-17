# dvr-playback

A lightweight Dockerized **ThroughTek (TUTK) IOTC P2P** bridge for **ZOSI / Ansjer** DVRs. It exposes a simple HTTP REST API and fragmented-MP4 (fMP4) WebSocket streams so browsers and home automation dashboards can browse historic DVR recordings, stream live or recorded video, download MP4 clips, and fetch camera snapshots without Wine or cloud apps.

## Features

- **Recording Index (`GET /api/recordings`)**: Queries the DVR's hard drive over TUTK (`IOTYPE_LISTEVENT_REQ` / `RESP`) for a date or time range.
- **Historic Playback (`WS /playback`)**: Streams recorded H.265/H.264 video from the DVR via `tutk_helper` and remuxes/transcodes via `ffmpeg` to browser-friendly fMP4 over WebSocket.
- **Live Streaming (`WS /live`)**: Streams live camera channels over WebSocket as fMP4.
- **Clip Download (`GET /api/download`)**: Exports a recording window as a downloadable `.mp4` file (transcoded H.264 by default, or `codec=copy`).
- **Snapshots (`GET /api/snapshot`)**: Grabs cached JPEG frames from the DVR's local RTSP feed (`RTSP_HOST`).
- **Docker & CasaOS Ready**: Multi-stage `Dockerfile` and `docker-compose.yml` (with `x-casaos` metadata).

---

## Architecture

```
Browser / Client
   ├── HTTP REST & WebSocket (fMP4) ──▶ Node.js Server (dist/server.js)
   │                                       ├── spawns native/tutk_helper (C + libIOTCAPIs_ALL.so) ──▶ DVR (TUTK UDP/P2P)
   │                                       └── spawns ffmpeg (H.265/H.264 -> fMP4 / MP4 / JPEG)  ──▶ DVR (RTSP TCP)
```

---

## Prerequisites: Proprietary TUTK SDK Files

> **Important:** The ThroughTek (TUTK) IOTC/AVAPI headers (`IOTCAPIs.h`, `AVAPIs.h`, `P2PTunnelAPIs.h`, `RDTAPIs.h`) and binary library (`libIOTCAPIs_ALL.so`) are **proprietary software** (Copyright ThroughTek Co., Ltd.) and are **excluded from this repository**.

You must obtain the TUTK IOTC SDK (x86_64 Linux) yourself before building:

1. **Obtain the SDK archive**
   - Request the official Linux IOTC SDK directly from ThroughTek, **or**
   - Locate a compatible `TUTK_IOTC_Platform_14W42P1.zip` (or similar `TUTK_IOTC_Platform_*` archive containing `Include/` headers and `Lib/Linux/x64/libIOTCAPIs.a` + `libAVAPIs.a`) from open-source camera bridge documentation (such as `wyzecam` / `wyze-rtsp-bridge` references).
   - Verify the archive contains:
     - `Include/IOTCAPIs.h`, `Include/AVAPIs.h` (and companion headers)
     - `Lib/Linux/x64/libIOTCAPIs.a`
     - `Lib/Linux/x64/libAVAPIs.a`

2. **Prepare `native/` using the setup script**
   ```bash
   ./scripts/setup-tutk.sh /path/to/TUTK_IOTC_Platform_14W42P1.zip
   # Or, if already extracted:
   ./scripts/setup-tutk.sh /path/to/TUTK_IOTC_Platform_14W42P1
   ```
   This copies the headers into `native/include/` and links `libAVAPIs.a` + `libIOTCAPIs.a` into `native/libIOTCAPIs_ALL.so`.

   <details>
   <summary>Manual equivalent (if you prefer not to use the script)</summary>

   ```bash
   mkdir -p native/include
   cp /path/to/TUTK_SDK/Include/*.h native/include/
   g++ -fpic -shared -Wl,--whole-archive \
     /path/to/TUTK_SDK/Lib/Linux/x64/libAVAPIs.a \
     /path/to/TUTK_SDK/Lib/Linux/x64/libIOTCAPIs.a \
     -Wl,--no-whole-archive -lpthread -o native/libIOTCAPIs_ALL.so
   ```
   </details>

---

## Configuration

Copy the example config and fill in your DVR's details (`config/config.json` is gitignored):

```bash
cp config/config.example.json config/config.json
```

```json
{
  "port": 3001,
  "uid": "YOUR_20_CHAR_DVR_UID",
  "user": "admin",
  "pass": "",
  "channels": 8,
  "rtspHost": "192.168.1.100:554"
}
```

### Environment Variables

Environment variables override values in `config.json`:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3001` | HTTP / WebSocket listen port |
| `CONFIG_PATH` | `/app/config/config.json` | Path to JSON config file |
| `DVR_UID` | `""` | 20-character TUTK P2P UID of your DVR |
| `DVR_USER` | `"admin"` | DVR username |
| `DVR_PASS` | `""` | DVR password |
| `DVR_CHANNELS` | `8` | Number of DVR channels (`1..N`) |
| `RTSP_HOST` | `""` | DVR RTSP `host:port` for `/api/snapshot` (e.g. `192.168.1.100:554`) |
| `SNAPSHOT_TTL_MS` | `15000` | Snapshot cache TTL in milliseconds |
| `HELPER_BIN` | `../native/tutk_helper` | Path to compiled `tutk_helper` binary |

---

## Building & Running

### Docker (Recommended)

> **Note:** `docker-compose.yml` uses `network_mode: host` so TUTK UDP LAN discovery can reach the DVR directly without NAT issues.

```bash
# 1. Build the Docker image (verifies TUTK SDK files exist first)
./scripts/build.sh

# 2. Start the container
docker compose up -d
```

If deploying on **CasaOS**, you can change the bind mount source in `docker-compose.yml` (e.g. `/data/config/dvr-playback/config`) to match your server's appdata path.

### Local / Native Development

Requires Node.js 22+, `gcc`, `g++`, and `ffmpeg`:

```bash
./scripts/build.sh --native
CONFIG_PATH=./config/config.json npm start
```

---

## API Reference

All routes also accept an optional `/dvr-playback` path prefix (e.g., `/dvr-playback/health`) for reverse-proxy setups.

- **`GET /health`** — Returns `{ "ok": true, "uid": "...", "channels": 8 }`.
- **`GET /api/recordings?ch=1&date=YYYY-MM-DD[&tzOffset=-600]`** — Lists recordings for a local date (`tzOffset` uses JS `getTimezoneOffset()` minutes) or explicit `?ch=1&start=YYYY-MM-DDTHH:MM:SS&end=YYYY-MM-DDTHH:MM:SS`.
- **`GET /api/download?ch=1&start=YYYY-MM-DDTHH:MM:SS[&duration=60][&codec=copy]`** — Downloads an MP4 clip (`duration` in seconds, `1..7200`).
- **`GET /api/snapshot?ch=1[&fresh=1]`** — Returns a JPEG snapshot from RTSP (`RTSP_HOST` must be configured).
- **`WS /playback?ch=1&start=YYYY-MM-DDTHH:MM:SS[&quality=sd|hd]`** — Streams fMP4 playback over WebSocket.
- **`WS /live?ch=1[&quality=sd|hd]`** — Streams fMP4 live video over WebSocket.
