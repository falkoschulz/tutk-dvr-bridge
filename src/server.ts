import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { WebSocketServer, type WebSocket } from "ws";

interface ConfigFile {
  port?: number;
  uid?: string;
  user?: string;
  pass?: string;
  channels?: number;
  rtspHost?: string;
}

const CONFIG_PATH = process.env.CONFIG_PATH ?? "/app/config/config.json";
let fileCfg: ConfigFile = {};
try {
  if (fs.existsSync(CONFIG_PATH)) {
    fileCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as ConfigFile;
  }
} catch (e) {
  console.warn(`Failed to read ${CONFIG_PATH}:`, (e as Error).message);
}

const PORT = Number(process.env.PORT ?? fileCfg.port ?? 3001);
const DVR_UID = process.env.DVR_UID ?? fileCfg.uid ?? "";
const DVR_USER = process.env.DVR_USER ?? fileCfg.user ?? "admin";
const DVR_PASS = process.env.DVR_PASS ?? fileCfg.pass ?? "";
const CHANNELS = Number(process.env.DVR_CHANNELS ?? fileCfg.channels ?? 8);
const RTSP_HOST = process.env.RTSP_HOST ?? fileCfg.rtspHost ?? "";
const HELPER_BIN = process.env.HELPER_BIN ?? path.resolve(import.meta.dirname, "../native/tutk_helper");

if (!DVR_UID) {
  console.warn("[config] DVR_UID is not set (configure via DVR_UID env var or config.json)");
}

const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

function stopHelperAndWait(proc: ChildProcess | undefined): Promise<void> {
  if (!proc || proc.exitCode !== null || proc.killed) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      clearTimeout(capTimer);
      resolve();
    };
    proc.once("exit", finish);
    proc.once("close", finish);
    try { proc.stdin?.write("STOP\n"); } catch {}
    const killTimer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
    }, 400);
    const capTimer = setTimeout(finish, 2000);
  });
}

// Serialize TUTK list queries so concurrent HTTP requests don't collide on UDP discovery.
let listQueue: Promise<void> = Promise.resolve();
function enqueueList<T>(fn: () => Promise<T>): Promise<T> {
  const next = listQueue.then(fn, fn);
  listQueue = next.then(() => undefined, () => undefined);
  return next;
}

// Serialize stream session transitions (live <-> playback, clip <-> clip) so tutk_helper never overlaps.
let streamLock: Promise<void> = Promise.resolve();
function withStreamLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = streamLock.then(fn, fn);
  streamLock = next.then(() => undefined, () => undefined);
  return next;
}

function fmtIsoUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19);
}

function runList(ch1Based: number, startIso: string, endIso?: string): Promise<string> {
  return enqueueList(
    () =>
      new Promise((resolve, reject) => {
        const args = ["list", DVR_UID, DVR_USER, DVR_PASS, String(ch1Based - 1), startIso];
        if (endIso) args.push(endIso);
        const proc = spawn(HELPER_BIN, args);
        let out = "";
        let err = "";
        const timer = setTimeout(() => {
          proc.kill("SIGKILL");
          reject(new Error("tutk_helper list timed out"));
        }, 20000);
        proc.stdout.on("data", (d) => (out += d.toString()));
        proc.stderr.on("data", (d) => (err += d.toString()));
        proc.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0 && out.trim().startsWith("{")) resolve(out.trim());
          else reject(new Error(err.trim() || `tutk_helper exited ${code}`));
        });
      }),
  );
}

const SNAPSHOT_TTL_MS = Number(process.env.SNAPSHOT_TTL_MS ?? 15000);
const snapshotCache = new Map<number, { buf: Buffer; ts: number }>();
const snapshotInflight = new Map<number, Promise<Buffer>>();

function grabRtspSnapshot(ch1Based: number): Promise<Buffer> {
  if (!RTSP_HOST) {
    return Promise.reject(new Error("RTSP_HOST is not configured"));
  }
  return new Promise<Buffer>((resolve, reject) => {
    const url = `rtsp://${RTSP_HOST}/video${ch1Based}`;
    const ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-rtsp_transport", "tcp",
      "-skip_frame", "nokey",
      "-i", url,
      "-frames:v", "1", "-vf", "scale=-2:480", "-q:v", "4",
      "-f", "image2pipe", "-vcodec", "mjpeg",
      "pipe:1",
    ]);
    const chunks: Buffer[] = [];
    let err = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ff.kill("SIGKILL");
      reject(new Error("rtsp snapshot timed out"));
    }, 8000);
    ff.stdout.on("data", (d: Buffer) => chunks.push(d));
    ff.stderr.on("data", (d: Buffer) => (err += d.toString()));
    ff.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const buf = Buffer.concat(chunks);
      if (code === 0 && buf.length > 0) resolve(buf);
      else reject(new Error(err.trim() || `rtsp snapshot exited ${code}`));
    });
  });
}

function grabTutkSnapshot(ch1Based: number): Promise<Buffer> {
  return enqueueList(() => new Promise<Buffer>((resolve, reject) => {
    const helper = spawn(HELPER_BIN, ["live", DVR_UID, DVR_USER, DVR_PASS, String(ch1Based - 1)]);
    const ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-probesize", "524288", "-analyzeduration", "2000000",
      "-f", "hevc", "-i", "pipe:0",
      "-frames:v", "1", "-q:v", "4",
      "-f", "image2pipe", "-vcodec", "mjpeg",
      "pipe:1",
    ]);

    const chunks: Buffer[] = [];
    let err = "";
    let settled = false;

    const cleanup = () => {
      try { helper.stdin?.write("STOP\n"); } catch {}
      setTimeout(() => helper.kill("SIGKILL"), 300);
      ff.kill("SIGTERM");
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("tutk snapshot timed out"));
    }, 15000);

    helper.stdout?.pipe(ff.stdin!);
    ff.stdout?.on("data", (d: Buffer) => chunks.push(d));
    ff.stderr?.on("data", (d: Buffer) => (err += d.toString()));

    ff.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      cleanup();
      const buf = Buffer.concat(chunks);
      if (code === 0 && buf.length > 0) resolve(buf);
      else reject(new Error(err.trim() || `ffmpeg snapshot exited ${code}`));
    });
  }));
}

function grabSnapshot(ch1Based: number): Promise<Buffer> {
  const inflight = snapshotInflight.get(ch1Based);
  if (inflight) return inflight;

  const run = async () => {
    let buf: Buffer;
    if (RTSP_HOST) {
      try {
        buf = await grabRtspSnapshot(ch1Based);
      } catch {
        buf = await grabTutkSnapshot(ch1Based);
      }
    } else {
      buf = await grabTutkSnapshot(ch1Based);
    }
    snapshotCache.set(ch1Based, { buf, ts: Date.now() });
    return buf;
  };

  const p = run().finally(() => {
    snapshotInflight.delete(ch1Based);
  });
  snapshotInflight.set(ch1Based, p);
  return p;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname.replace(/^\/dvr-playback(?=\/|$)/, "") || "/";

  if (pathname === "/health") {
    return sendJson(res, 200, { ok: true, uid: DVR_UID, channels: CHANNELS });
  }

  if (pathname === "/api/snapshot" && req.method === "GET") {
    const ch = Number(url.searchParams.get("ch"));
    if (!Number.isInteger(ch) || ch < 1 || ch > CHANNELS) {
      return sendJson(res, 400, { error: `Invalid ch (expected 1..${CHANNELS})` });
    }
    const fresh = url.searchParams.get("fresh") === "1";
    const cached = snapshotCache.get(ch);
    if (!fresh && cached && Date.now() - cached.ts < SNAPSHOT_TTL_MS) {
      res.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Content-Length": String(cached.buf.length),
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      });
      return res.end(cached.buf);
    }
    try {
      const buf = await grabSnapshot(ch);
      res.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Content-Length": String(buf.length),
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      });
      return res.end(buf);
    } catch (e) {
      console.error(`[snapshot ch${ch}] ${(e as Error).message}`);
      if (cached) {
        res.writeHead(200, {
          "Content-Type": "image/jpeg",
          "Content-Length": String(cached.buf.length),
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
        });
        return res.end(cached.buf);
      }
      res.writeHead(204, { "Access-Control-Allow-Origin": "*" });
      return res.end();
    }
  }

  if (pathname === "/api/download" && req.method === "GET") {
    const ch = Number(url.searchParams.get("ch"));
    const start = url.searchParams.get("start") ?? "";
    const durParam = url.searchParams.get("duration");
    const duration = durParam ? Number(durParam) : 60;
    const codecCopy = url.searchParams.get("codec") === "copy";

    if (!Number.isInteger(ch) || ch < 1 || ch > CHANNELS) {
      return sendJson(res, 400, { error: `Invalid ch (expected 1..${CHANNELS})` });
    }
    if (!ISO_DT_RE.test(start)) {
      return sendJson(res, 400, { error: "Invalid start (expected YYYY-MM-DDTHH:MM:SS)" });
    }
    if (!Number.isFinite(duration) || duration <= 0 || duration > 7200) {
      return sendJson(res, 400, { error: "Invalid duration (expected 1..7200 seconds)" });
    }

    const safeTs = start.replace(/:/g, "-");
    const filename = `ch${ch}_${safeTs}.mp4`;

    let helper: ChildProcess | undefined;
    let ff: ChildProcess | undefined;
    let closed = false;
    let sentBytes = 0;

    const stopDownload = async () => {
      if (closed) return;
      closed = true;
      ff?.kill("SIGTERM");
      await stopHelperAndWait(helper);
    };
    const sessionHandle = { stop: stopDownload };

    req.on("close", () => {
      if (activePlayback === sessionHandle) activePlayback = null;
      void stopDownload();
    });

    await withStreamLock(async () => {
      if (closed || req.destroyed) return;
      await stopAllSessions();
      if (closed || req.destroyed) return;

      activePlayback = sessionHandle;
      console.log(`[dl ch${ch}] start ${start} duration=${duration}s codec=${codecCopy ? "copy" : "h264"}`);

      helper = spawn(HELPER_BIN, ["stream", DVR_UID, DVR_USER, DVR_PASS, String(ch - 1), start]);
      const ffArgs = [
        "-hide_banner", "-loglevel", "warning",
        "-probesize", "262144", "-analyzeduration", "500000",
        "-fflags", "+genpts", "-r", "15",
        "-f", "hevc", "-i", "pipe:0",
        "-t", String(duration),
        "-an",
      ];
      if (codecCopy) {
        ffArgs.push("-c:v", "copy", "-tag:v", "hvc1");
      } else {
        ffArgs.push("-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "25");
      }
      ffArgs.push("-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "pipe:1");

      ff = spawn("ffmpeg", ffArgs);
      helper.stdout?.pipe(ff.stdin!);

      await new Promise<void>((resolve) => {
        let headersSent = false;
        const ensureHeaders = () => {
          if (headersSent) return;
          headersSent = true;
          res.writeHead(200, {
            "Content-Type": "video/mp4",
            "Content-Disposition": `attachment; filename="${filename}"`,
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*",
          });
        };

        ff!.stdout?.on("data", (chunk: Buffer) => {
          if (closed || res.writableEnded) return;
          ensureHeaders();
          sentBytes += chunk.length;
          res.write(chunk);
        });

        ff!.stderr?.on("data", (d: Buffer) => process.stderr.write(`[dl ch${ch} ffmpeg] ${d}`));
        helper!.stderr?.on("data", (d: Buffer) => {
          const s = d.toString().trim();
          if (s && !s.startsWith("STATUS:playing")) console.error(`[dl ch${ch} helper] ${s}`);
        });

        const finish = (src: string, code: number | null) => {
          console.log(`[dl ch${ch}] ${src} exited (${code}), sentBytes=${sentBytes}`);
          if (activePlayback === sessionHandle) activePlayback = null;
          if (!headersSent && !res.writableEnded) {
            sendJson(res, 502, { error: "Failed to export clip (no video frames received)" });
          } else if (!res.writableEnded) {
            res.end();
          }
          void stopDownload().then(resolve);
        };

        ff!.once("close", (code) => finish("ffmpeg", code));
        helper!.once("exit", (code) => {
          if (sentBytes === 0) finish("helper", code);
        });
      });
    });
    return;
  }

  if (pathname === "/api/recordings" && req.method === "GET") {
    const ch = Number(url.searchParams.get("ch"));
    if (!Number.isInteger(ch) || ch < 1 || ch > CHANNELS) {
      return sendJson(res, 400, { error: `Invalid ch (expected 1..${CHANNELS})` });
    }

    const startParam = url.searchParams.get("start");
    const endParam = url.searchParams.get("end");
    const dateParam = url.searchParams.get("date") ?? "";
    const tzOffsetParam = url.searchParams.get("tzOffset");

    let startIso: string;
    let endIso: string | undefined;

    if (startParam && endParam) {
      if (!ISO_DT_RE.test(startParam) || !ISO_DT_RE.test(endParam)) {
        return sendJson(res, 400, { error: "Invalid start/end (expected YYYY-MM-DDTHH:MM:SS)" });
      }
      startIso = startParam;
      endIso = endParam;
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      if (tzOffsetParam !== null) {
        const tzMin = Number(tzOffsetParam);
        if (!Number.isFinite(tzMin)) {
          return sendJson(res, 400, { error: "Invalid tzOffset (expected minutes)" });
        }
        // JS getTimezoneOffset() convention: UTC+10 = -600 -> local 00:00 = UTC + tzMin
        const dayStartMs = Date.parse(`${dateParam}T00:00:00Z`) + tzMin * 60_000;
        startIso = fmtIsoUtc(dayStartMs);
        endIso = fmtIsoUtc(dayStartMs + 86_400_000 - 1000);
      } else {
        startIso = dateParam;
      }
    } else {
      return sendJson(res, 400, { error: "Expected ?date=YYYY-MM-DD (optional tzOffset) or ?start=...&end=..." });
    }

    try {
      const json = await runList(ch, startIso, endIso);
      return sendJson(res, 200, json);
    } catch (e) {
      return sendJson(res, 502, { error: (e as Error).message });
    }
  }

  sendJson(res, 404, { error: "Not found" });
});

interface ControlMsg {
  cmd?: "pause" | "resume" | "seek" | "stop";
  time?: string;
}

const wss = new WebSocketServer({ noServer: true });

function buildFfmpegArgs(scale720: boolean, _playback: boolean): string[] {
  const args = [
    "-hide_banner", "-loglevel", "warning",
    // tutk_helper guarantees the first frame is an IDR keyframe (~90-150KB),
    // so 256KB / 0.5s is enough to probe HEVC without stalling startup for 5-8s.
    "-probesize", "262144",
    "-analyzeduration", "500000",
    "-fflags", "+genpts", "-r", "15",
    "-f", "hevc", "-i", "pipe:0",
    "-an",
    "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
  ];
  if (scale720) args.push("-vf", "scale=-2:720");
  args.push(
    "-g", "25", "-pix_fmt", "yuv420p",
    "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "pipe:1",
  );
  return args;
}

/** Shared live stream per (channel, quality) (idle until at least one client connects). */
class LiveChannel {
  private helper?: ChildProcess;
  private ffmpeg?: ChildProcess;
  private clients = new Set<WebSocket>();
  private initChunk?: Buffer;
  private stopTimer?: NodeJS.Timeout;

  constructor(readonly ch: number, readonly quality: "hd" | "sd") {}

  get hasClients(): boolean {
    return this.clients.size > 0;
  }

  get isActive(): boolean {
    return Boolean(this.helper || this.stopTimer);
  }

  add(ws: WebSocket) {
    clearTimeout(this.stopTimer);
    this.stopTimer = undefined;
    this.clients.add(ws);
    if (this.initChunk && ws.readyState === ws.OPEN) ws.send(this.initChunk);

    if (!this.helper) {
      void withStreamLock(async () => {
        if (this.clients.size === 0 || this.helper) return;
        await stopPlaybackAndIdleLive();
        if (this.clients.size > 0 && !this.helper) this.start();
      });
    }

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as ControlMsg;
        if (msg.cmd === "stop") ws.close();
      } catch {}
    });
    ws.on("close", () => {
      this.clients.delete(ws);
      if (this.clients.size === 0) {
        this.stopTimer = setTimeout(() => {
          void this.stopNow();
        }, 5000);
      }
    });
  }

  private start() {
    console.log(`[live ch${this.ch}:${this.quality}] start`);
    this.initChunk = undefined;
    const helper = spawn(HELPER_BIN, ["live", DVR_UID, DVR_USER, DVR_PASS, String(this.ch - 1), this.quality]);
    const ffmpeg = spawn("ffmpeg", buildFfmpegArgs(false, false));
    this.helper = helper;
    this.ffmpeg = ffmpeg;

    helper.stdout?.pipe(ffmpeg.stdin!);

    let first = true;
    ffmpeg.stdout?.on("data", (chunk: Buffer) => {
      if (first) {
        this.initChunk = chunk;
        first = false;
      }
      for (const c of this.clients) {
        if (c.readyState === c.OPEN) c.send(chunk);
      }
    });

    helper.stderr?.on("data", (d: Buffer) => {
      for (const line of d.toString().split("\n")) {
        if (!line.trim()) continue;
        if (line.startsWith("STATUS:")) {
          const rest = line.slice(7);
          const state = rest.split(" ")[0];
          const msg = state === "error"
            ? JSON.stringify({ type: "error", message: rest.slice(6) || "Live stream error" })
            : JSON.stringify({ type: "status", state, detail: rest });
          for (const c of this.clients) if (c.readyState === c.OPEN) c.send(msg);
        } else {
          console.error(`[live ch${this.ch} helper] ${line}`);
        }
      }
    });

    ffmpeg.stderr?.on("data", (d: Buffer) => process.stderr.write(`[live ch${this.ch} ffmpeg] ${d}`));

    helper.on("exit", (code) => {
      console.log(`[live ch${this.ch}] helper exited (${code})`);
      if (this.helper === helper) {
        this.helper = undefined;
        this.ffmpeg?.kill("SIGTERM");
        this.ffmpeg = undefined;
        if (this.clients.size > 0) setTimeout(() => this.start(), 2000);
      }
    });
  }

  async stopNow(): Promise<void> {
    clearTimeout(this.stopTimer);
    this.stopTimer = undefined;
    if (!this.helper && !this.ffmpeg) return;
    console.log(`[live ch${this.ch}] stopping`);
    const h = this.helper;
    const f = this.ffmpeg;
    this.helper = undefined;
    this.ffmpeg = undefined;
    this.initChunk = undefined;
    for (const c of this.clients) {
      if (c.readyState === c.OPEN) c.close();
    }
    this.clients.clear();
    f?.kill("SIGTERM");
    await stopHelperAndWait(h);
  }
}

const liveChannels = new Map<string, LiveChannel>();
function getLiveChannel(ch: number, quality: "hd" | "sd"): LiveChannel {
  const key = `${ch}:${quality}`;
  let chan = liveChannels.get(key);
  if (!chan) {
    chan = new LiveChannel(ch, quality);
    liveChannels.set(key, chan);
  }
  return chan;
}

let activePlayback: { stop: () => Promise<void> } | null = null;

async function stopPlaybackAndIdleLive(): Promise<void> {
  if (activePlayback) {
    const pb = activePlayback;
    activePlayback = null;
    await pb.stop();
  }
  for (const chan of liveChannels.values()) {
    if (!chan.hasClients && chan.isActive) {
      await chan.stopNow();
    }
  }
}

async function stopAllSessions(): Promise<void> {
  if (activePlayback) {
    const pb = activePlayback;
    activePlayback = null;
    await pb.stop();
  }
  for (const chan of liveChannels.values()) {
    if (chan.isActive) {
      await chan.stopNow();
    }
  }
}

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname.replace(/^\/dvr-playback(?=\/|$)/, "") || "/";
  if (pathname !== "/playback" && pathname !== "/live") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws: WebSocket, req) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname.replace(/^\/dvr-playback(?=\/|$)/, "") || "/";
  const ch = Number(url.searchParams.get("ch"));
  const quality: "hd" | "sd" = url.searchParams.get("quality") === "hd" ? "hd" : "sd";

  if (pathname === "/live") {
    if (!Number.isInteger(ch) || ch < 1 || ch > CHANNELS) {
      ws.send(JSON.stringify({ type: "error", message: `Expected ?ch=1..${CHANNELS}` }));
      ws.close(1008);
      return;
    }
    getLiveChannel(ch, quality).add(ws);
    return;
  }

  const start = url.searchParams.get("start") ?? "";
  if (!Number.isInteger(ch) || ch < 1 || ch > CHANNELS || !ISO_DT_RE.test(start)) {
    ws.send(JSON.stringify({ type: "error", message: "Expected ?ch=1..8&start=YYYY-MM-DDTHH:MM:SS" }));
    ws.close(1008);
    return;
  }

  let helper: ChildProcess | undefined;
  let ffmpeg: ChildProcess | undefined;
  let closed = false;
  let sentVideoBytes = 0;
  let lastErrorMsg = "";

  const stopSession = async () => {
    if (closed) return;
    closed = true;
    ffmpeg?.kill("SIGTERM");
    await stopHelperAndWait(helper);
  };

  const sessionHandle = { stop: stopSession };

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as ControlMsg;
      if (msg.cmd === "pause") helper?.stdin?.write("PAUSE\n");
      else if (msg.cmd === "resume") helper?.stdin?.write("RESUME\n");
      else if (msg.cmd === "seek" && msg.time && ISO_DT_RE.test(msg.time)) {
        helper?.stdin?.write(`SEEK ${msg.time}\n`);
      } else if (msg.cmd === "stop") {
        void stopSession().then(() => {
          if (ws.readyState === ws.OPEN) ws.close();
        });
      }
    } catch {}
  });

  ws.on("close", () => {
    if (activePlayback === sessionHandle) activePlayback = null;
    void stopSession();
  });

  void withStreamLock(async () => {
    if (closed || ws.readyState !== ws.OPEN) return;
    await stopAllSessions();
    if (closed || ws.readyState !== ws.OPEN) return;

    activePlayback = sessionHandle;
    console.log(`[pb ch${ch}:${quality}] start ${start}`);

    const h = spawn(HELPER_BIN, ["stream", DVR_UID, DVR_USER, DVR_PASS, String(ch - 1), start]);
    const ff = spawn("ffmpeg", buildFfmpegArgs(quality === "sd", true));
    helper = h;
    ffmpeg = ff;

    h.stdout?.pipe(ff.stdin!);

    ff.stdout?.on("data", (chunk: Buffer) => {
      sentVideoBytes += chunk.length;
      if (ws.readyState === ws.OPEN) ws.send(chunk);
    });

    h.stderr?.on("data", (d: Buffer) => {
      for (const line of d.toString().split("\n")) {
        if (!line.trim()) continue;
        if (line.startsWith("STATUS:")) {
          const rest = line.slice(7);
          const state = rest.split(" ")[0];
          if (state === "error") {
            lastErrorMsg = rest.slice(6).trim() || "DVR playback error";
          } else if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: "status", state, detail: rest }));
          }
        } else {
          console.error(`[pb ch${ch} helper] ${line}`);
        }
      }
    });

    ff.stderr?.on("data", (d: Buffer) => process.stderr.write(`[pb ch${ch} ffmpeg] ${d}`));

    const onEnd = (source: string, code: number | null) => {
      console.log(`[pb ch${ch}] ${source} exited (${code}), sentBytes=${sentVideoBytes}`);
      if (closed) return;
      if (activePlayback === sessionHandle) activePlayback = null;
      if (ws.readyState === ws.OPEN) {
        if (sentVideoBytes === 0) {
          ws.send(JSON.stringify({
            type: "error",
            message: lastErrorMsg || "DVR playback failed to produce video",
          }));
        } else {
          ws.send(JSON.stringify({ type: "status", state: "stopped", code }));
        }
        ws.close();
      }
      void stopSession();
    };

    h.on("exit", (code) => onEnd("helper", code));
    ff.on("exit", (code) => {
      if (sentVideoBytes === 0) onEnd("ffmpeg", code);
    });
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`dvr-playback listening on :${PORT} (uid=${DVR_UID})`);
});
