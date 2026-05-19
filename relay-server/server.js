// Emoji Encore — multiplayer relay server.
//
// A tiny, game-agnostic WebSocket relay. A player HOSTs a room (the server mints a short
// share code) or JOINs an existing one by code; thereafter every message a player sends
// is relayed verbatim to the other player(s) in the same room. The server never inspects
// or interprets the `data` payload — the game protocol lives entirely in the client
// (packages/multiplayer) — so this same relay can back any game, not just Emoji Encore.
//
// Protocol (JSON text frames over WebSocket) — see README.md for the full table.
//   client → server : {type:'host', size?}  {type:'join', code}  {type:'msg', data}  {type:'ping'}
//   server → client : {type:'hosted'|'joined'|'peer-join'|'peer-leave'|'msg'|'error'|'pong'}
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

/** Live rooms — `code` → `{ size, peers: Map<peerId, ws> }`. */
const rooms = new Map();

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
  rooms.set(code, { size, peers: new Map([[ws.peerId, ws]]) });
  ws.roomCode = code;
  send(ws, { type: 'hosted', code, peerId: ws.peerId });
}

/** `{type:'join', code}` — add the client to an existing room, or report why not. */
function handleJoin(ws, msg) {
  const code = String(msg.code || '').toUpperCase().trim();
  const room = rooms.get(code);
  if (!room) {
    send(ws, { type: 'error', reason: 'no-room', code });
    return;
  }
  if (room.peers.size >= room.size) {
    send(ws, { type: 'error', reason: 'room-full', code });
    return;
  }
  if (ws.roomCode) leaveRoom(ws);
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
  res.end('Emoji Encore relay server — ok\n');
});

const wss = new WebSocketServer({ server: httpServer, maxPayload: 1 << 20 });

wss.on('connection', (ws) => {
  ws.peerId = crypto.randomUUID();
  ws.roomCode = null;
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

httpServer.listen(PORT, () => {
  console.log(`Emoji Encore relay server listening on :${PORT}`);
});
