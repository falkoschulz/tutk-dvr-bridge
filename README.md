# tutk-dvr-bridge

A lightweight Dockerized **ThroughTek (TUTK) IOTC P2P** bridge for **Ansjer / ZOSI / Cocoon** DVRs. It exposes a simple HTTP REST API and fragmented-MP4 (fMP4) WebSocket streams so browsers and home automation dashboards can browse historic DVR recordings, stream live or recorded video, download MP4 clips, and fetch camera snapshots without Wine or cloud apps.

## Tested Hardware

Built and tested against an **8-channel Cocoon Security DVR** ([cocoonproducts.com.au](https://cocoonproducts.com.au/)), and compatible with **Ansjer / ZOSI** OEM DVR/NVR units that use the Windows **AVSS** client and ThroughTek (TUTK) IOTC P2P.

## Features

- **Recording Index (`GET /api/recordings`)**: Queries the DVR's hard drive over TUTK (`IOTYPE_LISTEVENT_REQ` / `RESP`) for a date or time range.
- **Historic Playback (`WS /playback`)**: Streams recorded H.265/H.264 video from the DVR via `tutk_helper` and remuxes/transcodes via `ffmpeg` to browser-friendly fMP4 over WebSocket.
- **Live Streaming (`WS /live`)**: Streams live camera channels over WebSocket as fMP4 (`sd` or `hd`).
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

You must obtain the Linux x86_64 TUTK IOTC SDK yourself before building:

1. **Obtain the SDK archive**
   - Request the official Linux IOTC SDK directly from ThroughTek, **or**
   - Look for `TUTK_IOTC_Platform_14W42P1.zip` (a widely referenced SDK archive used by open-source camera bridges such as `nblavoie/wyzecam-api` and `kroo/wyzecam` on GitHub).
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

## How It Works & Protocol Notes

### Why RTSP Alone Isn't Enough
On many Ansjer/ZOSI/Cocoon DVRs, only TCP port `554` (RTSP) is exposed on the LAN, and it **only serves live streams** (`/video1` .. `/videoN`). Historic recording lists and hard-drive playback are not exposed over RTSP or HTTP — they are only available over **ThroughTek (TUTK) IOTC P2P**.

### Local LAN Connection (No Cloud Required)
`native/tutk_helper.c` initializes the TUTK library (`IOTC_Initialize2(0)` + `avInitialize`), connects directly to the DVR by its 20-character UID (`IOTC_Connect_ByUID_Parallel`), and starts an AV client session (`avClientStart`). When on the same LAN, TUTK negotiates direct local UDP (`mode = 2`) without needing cloud relay servers.

### Ansjer / ZOSI TUTK IOTC Commands
The DVR uses custom Ansjer/ZOSI `IOTYPE` payloads over `avSendIOCtrl` / `avRecvIOCtrl`:

| Mode | Message Types | Purpose |
| --- | --- | --- |
| **List Recordings** | `0x0318` (`IOTYPE_LISTEVENT_REQ`) → `0x0319` (`IOTYPE_LISTEVENT_RESP`) | Queries `AnsjerEventItem` entries (start `STimeDay` + `duration` in seconds) for a 0-based channel and UTC time window. |
| **Playback Control** | `0x031A` (`IOTYPE_RECORD_PLAYCONTROL`) → `0x031B` (`IOTYPE_RECORD_PLAYCTRL_RESP`) | Opens a dedicated playback AV channel and sends `PLAY_CMD_START` (`16`), `PLAY_CMD_STOP` (`1`), `PLAY_CMD_PAUSE` (`0`), or `PLAY_CMD_SEEK` (`6`). |
| **Live Stream** | `0x01FF` (`IOTYPE_IPCAM_START`), `0x02FF` (`IOTYPE_IPCAM_STOP`), `0x0320` (`IOTYPE_SETSTREAMCTRL_REQ`) | Starts/stops live video on a channel and selects stream quality (`hd` / `sd`). |

`tutk_helper` writes raw H.265/H.264 Annex-B video frames to `stdout`, which the Node.js server pipes into `ffmpeg` to produce browser-compatible fragmented MP4 (`-movflags frag_keyframe+empty_moov+default_base_moof`) over WebSocket or standard `.mp4` downloads.

### Docker Networking
`docker-compose.yml` uses `network_mode: host` so TUTK UDP LAN discovery broadcasts can reach the DVR directly without container NAT interference.

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

### Finding Your DVR's 20-Character TUTK UID

You can obtain the 20-character `uid` from any of the following:
- **DVR Hardware / OSD:** Printed on the label/sticker on the DVR unit, or shown in the DVR's local **Network / P2P / QR Code** menu.
- **ZosiSmart / AVSS App:** Visible in the device details/settings screen.
- **AVSS Debug Log (Windows or Wine):** When you log into the Windows **AVSS** desktop client, it queries the device list and writes the UID along with `IOTC_Connect_ByUID_Parallel` calls to `logDeBug/YYYY-MM-DD.txt` inside the AVSS installation folder.

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

```bash
# 1. Build the Docker image (verifies TUTK SDK files exist first)
./scripts/build.sh

# 2. Start the container
docker compose up -d
```

If deploying on **CasaOS**, you can change the bind mount source in `docker-compose.yml` (e.g. `/data/config/tutk-dvr-bridge/config`) to match your server's appdata path.

### Local / Native Development

Requires Node.js 22+, `gcc`, `g++`, and `ffmpeg`:

```bash
./scripts/build.sh --native
CONFIG_PATH=./config/config.json npm start
```

---

## API Reference

All routes also accept an optional `/dvr-playback` path prefix for reverse-proxy setups.

- **`GET /health`** — Returns `{ "ok": true, "uid": "...", "channels": 8 }`.
- **`GET /api/recordings?ch=1&date=YYYY-MM-DD[&tzOffset=-600]`** — Lists recordings for a local date (`tzOffset` uses JS `getTimezoneOffset()` minutes) or explicit `?ch=1&start=YYYY-MM-DDTHH:MM:SS&end=YYYY-MM-DDTHH:MM:SS`.
- **`GET /api/download?ch=1&start=YYYY-MM-DDTHH:MM:SS[&duration=60][&codec=copy]`** — Downloads an MP4 clip (`duration` in seconds, `1..7200`).
- **`GET /api/snapshot?ch=1[&fresh=1]`** — Returns a JPEG snapshot from RTSP (`RTSP_HOST` must be configured).
- **`WS /playback?ch=1&start=YYYY-MM-DDTHH:MM:SS[&quality=sd|hd]`** — Streams fMP4 playback over WebSocket.
- **`WS /live?ch=1[&quality=sd|hd]`** — Streams fMP4 live video over WebSocket.
