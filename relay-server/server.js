// Mojigames — multiplayer relay server.
//
// A tiny, game-agnostic WebSocket relay. A player HOSTs a room (the server mints a short
// share code) or JOINs an existing one by code; thereafter every message a player sends
// is relayed verbatim to the other player(s) in the same room. The server never inspects
// or interprets the `data` payload — the game protocol lives entirely in the client
// (packages/multiplayer) — so this one relay backs the online play of every Mojigames game at once.
//
// Protocol (JSON text frames over WebSocket) — see README.md for the full table.
//   client → server : {type:'host', size?}  {type:'join', code}  {type:'msg', data}  {type:'ping'}
//   server → client : {type:'hosted'|'joined'|'peer-join'|'peer-leave'|'msg'|'error'|'pong'}
//
// A room CLOSES when its host (the socket that created it) disconnects. The guests still in it
// are told exactly as before (`peer-leave`), but the code stops working: a later `join` gets
// `no-room`, instead of a seat in a room nobody will ever start.
//
// Run:    node server.js        (listens on $PORT, default 8787)
// Verify: node smoke-test.js    (with the server running)

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8787;
const HEARTBEAT_MS = 30_000; // terminate a socket that misses a ping/pong cycle
const DEFAULT_ROOM_SIZE = 2; // a Versus match; a host may request 2..MAX_ROOM_SIZE
const MAX_ROOM_SIZE = 8;
const CODE_LENGTH = 4;
// Code alphabet with no easily-confused glyphs (no I/L/O/0/1/B/8) — codes are read aloud
// and typed by hand, so legibility matters more than entropy.
const CODE_ALPHABET = 'ACDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * Live rooms — `code` → `{ size, hostId, open, peers: Map<peerId, ws> }`. `hostId` is the
 * peerId of the socket that created the room; `open` goes false for good when that socket
 * leaves (see leaveRoom). A closed room lingers only while stranded guests are still in it,
 * which also keeps its code from being handed to a new room while they are.
 */
const rooms = new Map();

// ── Rate limiting ────────────────────────────────────────────────────────────────────
// A 2026-07-17 audit found nothing here throttled room-code guessing (4-char/30-symbol
// alphabet = 810,000 combinations — scriptable in minutes against a live relay with no
// limit) or unbounded connection creation (a resource-exhaustion DoS). Two independent,
// deliberately simple limits — not trying to stop a determined, distributed attacker,
// just raising the cost enough that casual guessing/flooding against a free kids'-game
// relay isn't a five-minute script:
//   • per-connection: close a socket once it racks up too many wrong-code guesses in a
//     row — a real player mistyping a code a few times never gets close to this.
//   • per-IP: cap how many NEW connections one address can open per window, so closing a
//     spamming connection can't just be defeated by reconnecting immediately. Best-effort:
//     if this relay ever sits behind a proxy/tunnel that doesn't forward the real client
//     IP, every client behind it shares one bucket — that fails toward over-throttling a
//     shared address, never toward silently doing nothing.
const MAX_FAILED_JOINS_PER_CONNECTION = 5;
const MAX_CONNECTIONS_PER_IP_PER_WINDOW = 20;
const CONNECTION_WINDOW_MS = 10_000;

/** IP → `{ count, windowStart }` for the per-IP connection-rate limit. */
const connectionCounts = new Map();

/** True if `ip` is still under its connection budget for the current window. */
function ipAllowed(ip) {
  const now = Date.now();
  const entry = connectionCounts.get(ip);
  if (!entry || now - entry.windowStart > CONNECTION_WINDOW_MS) {
    connectionCounts.set(ip, { count: 1, windowStart: now });
    return true;
  }
  entry.count += 1;
  return entry.count <= MAX_CONNECTIONS_PER_IP_PER_WINDOW;
}

/** A fresh, currently-unused room code. */
function makeCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    }
  } while (rooms.has(code));
  return code;
}

/** Send a JSON message to one socket — a no-op if it is not open. */
function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

/** Send a JSON message to every peer in `room`, optionally skipping `exceptId`. */
function broadcast(room, msg, exceptId) {
  for (const [peerId, ws] of room.peers) {
    if (peerId !== exceptId) send(ws, msg);
  }
}

/** Drop a socket from its room, notify the rest, and delete the room once empty. */
function leaveRoom(ws) {
  const code = ws.roomCode;
  if (!code) return;
  ws.roomCode = null;
  const room = rooms.get(code);
  if (!room) return;
  room.peers.delete(ws.peerId);
  // The host is gone, so nothing in this room can ever start again: every game is
  // host-authoritative. Before this, the room stayed joinable for as long as anyone lingered in
  // it, and a friend arriving by the same code or share link was seated in a room with no host,
  // showing "0/6 in the room · waiting for the host to start…" forever.
  if (ws.peerId === room.hostId) room.open = false;
  if (room.peers.size === 0) {
    rooms.delete(code);
  } else {
    broadcast(room, { type: 'peer-leave', peerId: ws.peerId });
  }
}

/** `{type:'host', size?}` — create a room and report its code back to the host. */
function handleHost(ws, msg) {
  if (ws.roomCode) leaveRoom(ws); // a client holds at most one room
  const size = Math.min(
    MAX_ROOM_SIZE,
    Math.max(2, Number(msg.size) || DEFAULT_ROOM_SIZE),
  );
  const code = makeCode();
  rooms.set(code, { size, hostId: ws.peerId, open: true, peers: new Map([[ws.peerId, ws]]) });
  ws.roomCode = code;
  send(ws, { type: 'hosted', code, peerId: ws.peerId });
}

/** `{type:'join', code}` — add the client to an existing room, or report why not. */
function handleJoin(ws, msg) {
  const code = String(msg.code || '').toUpperCase().trim();
  const room = rooms.get(code);
  if (!room || !room.open) {
    // A room whose host has left answers exactly like a missing one: to the player the code is
    // simply dead, and every client already shows a friendly message for `no-room`.
    // Only a WRONG code counts toward the brute-force limit — a real code that's merely
    // full (below) or closed means they already had it, which isn't a guessing signal (someone
    // retrying a stale share link must not have their connection cut).
    if (!room) ws.failedJoins += 1;
    send(ws, { type: 'error', reason: 'no-room', code });
    if (ws.failedJoins >= MAX_FAILED_JOINS_PER_CONNECTION) {
      ws.close(1008, 'too many wrong codes');
    }
    return;
  }
  if (room.peers.size >= room.size) {
    send(ws, { type: 'error', reason: 'room-full', code });
    return;
  }
  if (ws.roomCode) leaveRoom(ws);
  // A correct code clears the brute-force tally. Without this the count only ever grows,
  // so a player who mistypes a code five times over one session — with successful joins in
  // between — has their socket closed and is wrongly told they lost their internet.
  ws.failedJoins = 0;
  // Hand the joiner the peers already present, then add them and announce to the rest.
  const existingPeers = [...room.peers.keys()];
  room.peers.set(ws.peerId, ws);
  ws.roomCode = code;
  send(ws, { type: 'joined', code, peerId: ws.peerId, peers: existingPeers });
  broadcast(room, { type: 'peer-join', peerId: ws.peerId }, ws.peerId);
}

/** `{type:'msg', data}` — relay `data` verbatim to every other peer in the room. */
function handleMsg(ws, msg) {
  const room = ws.roomCode && rooms.get(ws.roomCode);
  if (!room) {
    send(ws, { type: 'error', reason: 'not-in-room' });
    return;
  }
  broadcast(room, { type: 'msg', from: ws.peerId, data: msg.data }, ws.peerId);
}

// ── HTTP + WebSocket server ──────────────────────────────────────────────────────────
// A plain GET is answered as a health check (hosting platforms probe this); the WebSocket
// upgrade is handled by `ws`. `maxPayload` caps a frame well above any game message.

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Mojigames relay server — ok\n');
});

const wss = new WebSocketServer({ server: httpServer, maxPayload: 1 << 20 });

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress || 'unknown';
  if (!ipAllowed(ip)) {
    ws.close(1008, 'too many connections, slow down');
    return;
  }

  ws.peerId = crypto.randomUUID();
  ws.roomCode = null;
  ws.failedJoins = 0;
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: 'error', reason: 'bad-json' });
      return;
    }
    switch (msg && msg.type) {
      case 'host':
        handleHost(ws, msg);
        break;
      case 'join':
        handleJoin(ws, msg);
        break;
      case 'msg':
        handleMsg(ws, msg);
        break;
      case 'ping':
        send(ws, { type: 'pong' });
        break;
      default:
        send(ws, { type: 'error', reason: 'bad-type' });
    }
  });

  // `close` and `error` can both fire; leaveRoom is idempotent so a double call is safe.
  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => leaveRoom(ws));
});

// Heartbeat — a dead connection that never closes cleanly would otherwise leak its room.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeat));

// Forget IPs that have gone quiet, so this map doesn't grow forever.
const rateLimitSweep = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of connectionCounts) {
    if (now - entry.windowStart > CONNECTION_WINDOW_MS) connectionCounts.delete(ip);
  }
}, CONNECTION_WINDOW_MS);
wss.on('close', () => clearInterval(rateLimitSweep));

httpServer.listen(PORT, () => {
  console.log(`Mojigames relay server listening on :${PORT}`);
});
