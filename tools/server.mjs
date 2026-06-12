/**
 * Self-hosted BGEW multiplayer server — speaks the exact protocol the
 * engine's NetworkManager expects (the official bgew.stevecohen.fr server
 * was unreachable when this was written, and this also enables LAN play
 * and headless tests).
 *
 * REST (used by the engine):
 *   GET  /api/ping                  → "pong"
 *   POST /api/room                  → create room  {status, data:{uid}}
 *   GET  /api/room?open=&game=&version= → {status, servers:[Room]}
 *   POST /api/room/data/:uid        → set room data
 *   GET  /api/room/data/:uid        → get room data
 *   POST /api/room/close/:uid       → open/close room
 *
 * WebSocket on /<roomUid> :
 *   server → client: connected / room_full / player_join / player_leave /
 *                    broadcast / msg_sent     (SocketMessage shape)
 *   client → server: {id, msg}  → msg_sent ack + broadcast to the others
 *
 * Usage: node tools/server.mjs [port]   (default 8090)
 */
import http from "http";
import crypto from "crypto";
import { readFile } from "fs/promises";
import { extname, join, dirname, normalize } from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";

const PORT = Number(process.argv[2] || 8090);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".map": "application/json",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".woff2": "font/woff2",
  ".png": "image/png",
};

/** uid → room */
const rooms = new Map();

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, rejectUnauthorized",
};

function json(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json", ...CORS });
  res.end(JSON.stringify(body));
}

function roomView(room) {
  return {
    uid: room.uid,
    game: room.game,
    version: room.version,
    name: room.name,
    open: room.open && room.clients.size < room.limit,
    data: room.data,
    limit: room.limit,
    clients: [...room.clients.keys()],
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }

  let body = {};
  if (req.method === "POST") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try {
      body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    } catch {
      return json(res, 400, { status: "error", code: "bad_json" });
    }
  }

  if (path === "/api/ping") return json(res, 200, "pong");

  if (path === "/api/room" && req.method === "POST") {
    const uid = crypto.randomUUID();
    rooms.set(uid, {
      uid,
      game: body.game || "?",
      version: body.version || "?",
      name: body.name || "room",
      data: body.data || {},
      limit: body.limit || 0,
      open: true,
      clients: new Map(), // clientUid → ws
    });
    console.log(`+ room "${body.name}" (${uid}) for ${body.game} ${body.version}`);
    return json(res, 200, { status: "success", code: "room_created", data: { uid } });
  }

  if (path === "/api/room" && req.method === "GET") {
    const wantOpen = url.searchParams.get("open") !== "false";
    const game = url.searchParams.get("game");
    const version = url.searchParams.get("version");
    const servers = [...rooms.values()]
      .filter((r) => (!game || r.game === game) && (!version || r.version === version))
      .map(roomView)
      .filter((r) => r.open === wantOpen);
    return json(res, 200, { status: "success", servers });
  }

  const dataMatch = path.match(/^\/api\/room\/data\/(.+)$/);
  if (dataMatch) {
    const room = rooms.get(dataMatch[1]);
    if (!room) return json(res, 404, { status: "error", code: "room_not_found" });
    if (req.method === "POST") {
      room.data = body.merge ? { ...room.data, ...body.data } : body.data;
      return json(res, 200, { status: "success", code: "data_set", data: room.data });
    }
    return json(res, 200, { status: "success", code: "data", data: room.data });
  }

  const closeMatch = path.match(/^\/api\/room\/close\/(.+)$/);
  if (closeMatch && req.method === "POST") {
    const room = rooms.get(closeMatch[1]);
    if (!room) return json(res, 404, { status: "error", code: "room_not_found" });
    room.open = body.close === false;
    return json(res, 200, { status: "success", code: room.open ? "room_opened" : "room_closed" });
  }

  // Anything else: serve the game itself, so a single tunnel (ngrok…)
  // exposes both the game and its multiplayer backend.
  if (req.method === "GET" && !path.startsWith("/api/")) {
    try {
      const rel = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, "");
      const file = join(ROOT, rel === "/" || rel === "\\" ? "index.html" : rel);
      if (!file.startsWith(ROOT)) throw new Error("traversal");
      const data = await readFile(file);
      res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream", ...CORS });
      return res.end(data);
    } catch {
      res.writeHead(404, CORS);
      return res.end("not found");
    }
  }

  json(res, 404, { status: "error", code: "not_found" });
});

/* ------------------------------------------------------------------ *
 * WebSocket: one path per room
 * ------------------------------------------------------------------ */
const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const uid = decodeURIComponent((req.url || "/").slice(1).split("?")[0]);
  const room = rooms.get(uid);
  const send = (sock, obj) => {
    if (sock.readyState === sock.OPEN) sock.send(JSON.stringify(obj));
  };

  if (!room) {
    send(ws, { sender: "server", to: "", code: "room_full", data: { reason: "room_not_found" } });
    return ws.close();
  }
  if (room.limit > 0 && room.clients.size >= room.limit) {
    send(ws, { sender: "server", to: "", code: "room_full", data: {} });
    return ws.close();
  }

  const clientUid = crypto.randomUUID();
  room.clients.set(clientUid, ws);
  console.log(`→ ${clientUid.slice(0, 8)} joined "${room.name}" (${room.clients.size}/${room.limit || "∞"})`);

  send(ws, { sender: "server", to: clientUid, code: "connected", data: { uid: clientUid, room: roomView(room) } });
  for (const [otherUid, other] of room.clients) {
    if (otherUid !== clientUid) {
      send(other, { sender: clientUid, to: otherUid, code: "player_join", data: { uid: clientUid } });
    }
  }

  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    let packet;
    try {
      packet = JSON.parse(raw.toString());
    } catch {
      return;
    }
    ws.isAlive = true;
    // Ack so the engine resolves its sendMessage promise…
    send(ws, { sender: "server", to: clientUid, code: "msg_sent", data: { msg: packet } });
    // Keepalives stop here: traffic for the proxies, silence for the players
    if (packet.msg && packet.msg.type === "ka") return;
    // …and relay to everyone else — same shape as the official BGEW server:
    // `data` carries the WHOLE client packet ({id, msg})
    for (const [otherUid, other] of room.clients) {
      if (otherUid !== clientUid) {
        send(other, { sender: clientUid, to: otherUid, code: "broadcast", data: packet });
      }
    }
  });

  ws.on("close", () => {
    room.clients.delete(clientUid);
    console.log(`← ${clientUid.slice(0, 8)} left "${room.name}" (${room.clients.size} left)`);
    for (const [otherUid, other] of room.clients) {
      send(other, { sender: clientUid, to: otherUid, code: "player_leave", data: { uid: clientUid } });
    }
    // Empty rooms die after a minute
    if (room.clients.size === 0) {
      setTimeout(() => {
        const r = rooms.get(uid);
        if (r && r.clients.size === 0) {
          rooms.delete(uid);
          console.log(`- room "${room.name}" removed`);
        }
      }, 60_000);
    }
  });
});

/* Protocol-level pings: keeps idle sockets alive through proxies
 * (Cloudflare kills quiet websockets in ~90 s) and reaps dead clients so
 * the other player gets a real player_leave instead of a ghost. */
setInterval(() => {
  for (const client of wss.clients) {
    if (client.isAlive === false) {
      client.terminate();
      continue;
    }
    client.isAlive = false;
    client.ping();
  }
}, 25_000);

server.listen(PORT, () => {
  console.log(`BGEW WAR server ready on http://localhost:${PORT}  (game + REST /api + WS /<roomUid>)`);
  console.log(`Local play:  http://localhost:${PORT}/?server=same`);
  console.log(`Internet:    expose this port (ngrok http ${PORT}) and share  https://<tunnel>/?server=same`);
});
