// Mojigames — multiplayer relay server.
//
// A tiny, game-agnostic WebSocket relay. A player HOSTs a room (the server mints a short
// share code) or JOINs an existing one by code; thereafter every message a player sends
// is relayed verbatim to the other player(s) in the same room. The server never inspects
// or interprets the `data` payload — the game protocol lives entirely in the client
// (packages/multiplayer) — so this one relay backs the online play of every Mojigames game at once.
//
// Protocol (JSON text frames over WebSocket) — see README.md for the full table.
//   client → server : {type:'host', size?, v?, app?}  {type:'join', code, app?}  {type:'msg', data}
//                     {type:'ping'}  {type:'kick', peerId}
//   server → client : {type:'hosted'|'joined'|'peer-join'|'peer-leave'|'msg'|'error'|'pong'}
//
// Protocol v2 (2026-10-10, the kids-safety pass) — every new field is OPTIONAL, so every build
// from before it keeps working exactly as it did (see "Protocol v2" below and README.md):
//   • a host that sends `v: 2` gets a 6-character code; one that doesn't still gets 4;
//   • `app` ('cracktheclip' | 'mojino' | 'mojiventure' | …) tags a room with its game, and a join
//     from a different game is refused with `wrong-app` — a kids' room never mixes with anything;
//   • the per-IP limits key on the real client address (X-Forwarded-For), not Render's proxy,
//     and too many wrong codes from one address pauses its joins for a while (`too-many-tries`);
//   • the host may remove a player (`kick`).
//
// Two rules keep a room from hanging on someone who is no longer there:
//   • A room CLOSES when its host (the socket that created it) disconnects. The guests still in
//     it are told exactly as before (`peer-leave`), but the code stops working: a later `join`
//     gets `no-room`, instead of a seat in a room nobody will ever start.
//   • A client that sends app-level `{type:'ping'}`s is policed for silence — see the heartbeat
//     section at the bottom. Clients that never ping (every build before 2026-09-24) are not.
//
// Run:    node server.js        (listens on $PORT, default 8787)
// Verify: node smoke-test.js    (with the server running)
//         node reliability-test.js   (starts its own relay with short timeouts)

const http = require('http');
const crypto = require('crypto');
const net = require('net');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8787;
const HEARTBEAT_MS = 30_000; // terminate a socket that misses a ping/pong cycle
// Drop a socket that has been sending app-level pings and then goes quiet for this long.
// 150 s, not the 45 s (three missed 15 s pings) this was written with: Android pauses an app's
// timers as soon as it leaves the screen — even for the share sheet — so a host who pops into
// WhatsApp to send the room code stops pinging, and 45 s would have closed the room under them
// (2026-09-24 review). Two and a half minutes covers sending a link; a phone that has really gone
// to sleep is still noticed, just later — which beats the old "never". Env-tunable so a test can
// use ~1 s, and so it can be changed on Render without a code change.
const HEARTBEAT_TIMEOUT_MS = Number(process.env.HEARTBEAT_TIMEOUT_MS) || 150_000;
// How often to look for silent sockets — frequent enough that a drop lands within a few
// seconds of the limit, and never so rarely that a short test timeout overshoots badly.
const SILENCE_SWEEP_MS = Math.max(50, Math.min(5_000, Math.floor(HEARTBEAT_TIMEOUT_MS / 3)));
const DEFAULT_ROOM_SIZE = 2; // a Versus match; a host may request 2..MAX_ROOM_SIZE
const MAX_ROOM_SIZE = 8;
// Code alphabet with no easily-confused glyphs (no I/L/O/0/1/B/8) — codes are read aloud
// and typed by hand, so legibility matters more than entropy.
const CODE_ALPHABET = 'ACDEFGHJKMNPQRSTUVWXYZ23456789';
// 4 characters = 30^4 = 810,000 codes: guessable by a script, so a host that speaks protocol v2
// gets 6 (30^6 = 729 million). Builds from before v2 still get 4 — their own guests, also on old
// builds, are the people most likely to be joining them, and every shipped code box takes 4–6.
// The two lengths can never collide (a code's length tells you which kind it is).
const LEGACY_CODE_LENGTH = 4;
const V2_CODE_LENGTH = 6;
/** The protocol version this relay speaks. A host declares its own with `{type:'host', v}`. */
const PROTOCOL_VERSION = 2;

// ── Protocol v2: which game a room belongs to ────────────────────────────────────────
// One relay serves an 18+ casino party game (Mojino), an adult trivia game (Crack the Clip,
// formerly HitMoji) and a children's game (Mojiventure), and a room was keyed by its code alone:
// an adult mistyping a code could land in a child's room. A v2 client says which game it is
// (`app` on host and join); the relay remembers it per room and refuses a join from another game.
//
// The transition rules (old builds send no `app` at all):
//   • both sides declare an app and they differ           → `wrong-app`;
//   • either side is a STRICT app and the other side isn't the same app — including a side that
//     declares nothing — → `wrong-app`. Mojiventure is strict: it has never shipped a build
//     without `app`, so "no app" can only ever be some OTHER game, in either direction;
//   • otherwise (a non-strict app on one side, nothing on the other, or nothing on both) the join
//     is allowed, exactly as before v2 — Crack the Clip and Mojino players on last month's build
//     must still get into rooms their friends on this month's build host, and vice versa.
// Once every live Crack the Clip / Mojino build sends `app`, they can be added to STRICT_APPS too.
//
// `app` is a safety rail against MISTAKES, not a lock: anyone can send any string. What stops a
// stranger deliberately hunting for rooms is the 6-character code and the wrong-code limits below.
const STRICT_APPS = new Set(['mojiventure']);
const APP_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** A well-formed app id from a client message, lower-cased — or null (absent or malformed). */
function cleanAppId(raw) {
  if (typeof raw !== 'string') return null;
  const app = raw.trim().toLowerCase();
  return APP_ID_PATTERN.test(app) ? app : null;
}

/** May a guest declaring `guestApp` (null = an old build) join a room tagged `roomApp`? */
function appsCompatible(roomApp, guestApp) {
  if (roomApp && guestApp) return roomApp === guestApp;
  if (STRICT_APPS.has(roomApp) || STRICT_APPS.has(guestApp)) return false; // the other side is null
  return true;
}

/**
 * Live rooms — `code` → `{ size, hostId, open, app, kicked, peers: Map<peerId, ws> }`. `hostId`
 * is the peerId of the socket that created the room; `open` goes false for good when that socket
 * leaves (see leaveRoom). A closed room lingers only while stranded guests are still in it,
 * which also keeps its code from being handed to a new room while they are. `app` is the game the
 * host declared (null for a pre-v2 host); `kicked` holds the peerIds the host removed, so the
 * same connection can't simply re-join.
 */
const rooms = new Map();

// ── Rate limiting ────────────────────────────────────────────────────────────────────
// A 2026-07-17 audit found nothing here throttled room-code guessing or unbounded connection
// creation (a resource-exhaustion DoS). Deliberately simple limits — not trying to stop a
// determined, distributed attacker, just raising the cost enough that casual guessing/flooding
// against a free relay that a kids' game uses isn't a five-minute script:
//   • per-connection: close a socket once it racks up too many wrong-code guesses — a real
//     player mistyping a code a few times never gets close to this.
//   • per-IP, connections: cap how many NEW connections one address can open per window, so
//     closing a guessing connection can't be defeated by reconnecting immediately.
//   • per-IP, wrong codes (2026-10-10): too many wrong codes from one address within a minute
//     pauses ALL joins from it for a while (`too-many-tries`) — however many connections it uses.
//     Correct codes are refused during the pause too; otherwise the pause would still answer
//     "that one was real".
//
// "Per IP" used to mean req.socket.remoteAddress — which, behind Render, is Render's proxy, so
// every player in the world shared ONE bucket: 20 connections per 10 s for everybody, which
// barely slowed a guesser and could lock real players out at a busy moment (2026-10-10 audit).
// The client's address is now read from X-Forwarded-For — see clientIp().
const MAX_FAILED_JOINS_PER_CONNECTION = 5;
const MAX_CONNECTIONS_PER_IP_PER_WINDOW = 20;
const CONNECTION_WINDOW_MS = 10_000;
// 20 wrong codes a minute, not 10: one address can be a whole family on home Wi-Fi or a
// classroom behind a school's single address, and a pause blocks every one of them. Even at
// 20/min a guesser needs ~3 weeks per hit against a full house of 1,000 live 6-char rooms.
// Both env-tunable, so they can be changed on Render without a code change.
const MAX_FAILED_JOINS_PER_IP = Number(process.env.MAX_FAILED_JOINS_PER_IP) || 20;
const FAILED_JOIN_WINDOW_MS = 60_000;
const FAILED_JOIN_BLOCK_MS = Number(process.env.FAILED_JOIN_BLOCK_MS) || 120_000;

// Which X-Forwarded-For entry is the real client. Proxies APPEND to the header, and Render's
// does not strip what the client sent (a client can put anything at the front). Render says the
// FIRST entry is the real client when nobody is lying, so that is the default. Once the proxy
// chain is confirmed (GET /whoami with a fake X-Forwarded-For shows how many entries the proxies
// add), set XFF_TRUSTED_HOPS=N to read the Nth entry from the RIGHT instead — that one a client
// cannot forge. In the default mode a forger can give themselves fresh buckets (the
// per-connection limit still caps each socket at 5 wrong codes), or pause joins for an address
// they know and type in; the right-hand mode closes both.
const XFF_TRUSTED_HOPS = Math.max(0, Math.floor(Number(process.env.XFF_TRUSTED_HOPS) || 0));

/** `::ffff:1.2.3.4` → `1.2.3.4`, so one client never gets two buckets. */
function normalizeIp(ip) {
  const s = String(ip || '').trim();
  return s.startsWith('::ffff:') && net.isIPv4(s.slice(7)) ? s.slice(7) : s;
}

/** The address the rate limits key on — see XFF_TRUSTED_HOPS. Falls back to the socket's peer. */
function clientIp(req) {
  const socketIp = normalizeIp(req.socket.remoteAddress) || 'unknown';
  const header = req.headers['x-forwarded-for'];
  if (!header) return socketIp;
  const hops = String(Array.isArray(header) ? header.join(',') : header)
    .split(',')
    .map(normalizeIp)
    .filter(Boolean);
  const pick = XFF_TRUSTED_HOPS > 0 ? hops[hops.length - XFF_TRUSTED_HOPS] : hops[0];
  return pick && net.isIP(pick) ? pick : socketIp;
}

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

/** IP → `{ count, windowStart, blockedUntil }` for the per-IP wrong-code limit. */
const failedJoins = new Map();

/** Is this address in a wrong-code pause right now? */
function joinsBlocked(ip) {
  const entry = failedJoins.get(ip);
  return Boolean(entry && entry.blockedUntil > Date.now());
}

/** Count one wrong code against `ip`; reaching the limit starts a pause. */
function recordFailedJoin(ip) {
  const now = Date.now();
  let entry = failedJoins.get(ip);
  if (!entry || now - entry.windowStart > FAILED_JOIN_WINDOW_MS) {
    entry = { count: 0, windowStart: now, blockedUntil: 0 };
    failedJoins.set(ip, entry);
  }
  entry.count += 1;
  if (entry.count >= MAX_FAILED_JOINS_PER_IP) {
    entry.blockedUntil = now + FAILED_JOIN_BLOCK_MS;
    entry.count = 0;
    entry.windowStart = now;
  }
}

/** A fresh, currently-unused room code of `length` characters. */
function makeCode(length) {
  let code;
  do {
    code = '';
    for (let i = 0; i < length; i++) {
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

/** `{type:'host', size?, v?, app?}` — create a room and report its code back to the host. */
function handleHost(ws, msg) {
  if (ws.roomCode) leaveRoom(ws); // a client holds at most one room
  const size = Math.min(
    MAX_ROOM_SIZE,
    Math.max(2, Number(msg.size) || DEFAULT_ROOM_SIZE),
  );
  // Only a host that says it speaks v2 gets the long code: an older build's lobby and share text
  // were written around 4 characters, so it keeps getting exactly what it always got.
  const v2 = Number(msg.v) >= 2;
  const code = makeCode(v2 ? V2_CODE_LENGTH : LEGACY_CODE_LENGTH);
  rooms.set(code, {
    size,
    hostId: ws.peerId,
    open: true,
    app: cleanAppId(msg.app),
    kicked: new Set(),
    peers: new Map([[ws.peerId, ws]]),
  });
  ws.roomCode = code;
  send(ws, { type: 'hosted', code, peerId: ws.peerId });
}

/** `{type:'join', code, app?}` — add the client to an existing room, or report why not. */
function handleJoin(ws, msg) {
  // Spaces are dropped as well as trimmed: "ABC DEF" read off a screen is still ABCDEF.
  const code = String(msg.code || '').toUpperCase().replace(/\s+/g, '');
  // An address that has been guessing gets no answer about ANY code until its pause is over —
  // not even a right one (a "yes" would let the guessing carry on through the pause).
  if (joinsBlocked(ws.clientIp)) {
    send(ws, { type: 'error', reason: 'too-many-tries', code });
    return;
  }
  const room = rooms.get(code);
  /** A wrong code: count it (per connection and per address) and answer `reason`. */
  const refuse = (reason) => {
    ws.failedJoins += 1;
    recordFailedJoin(ws.clientIp);
    send(ws, { type: 'error', reason, code });
    if (ws.failedJoins >= MAX_FAILED_JOINS_PER_CONNECTION) {
      ws.close(1008, 'too many wrong codes');
    }
  };
  if (!room) {
    refuse('no-room');
    return;
  }
  if (!room.open) {
    // A room whose host has left answers exactly like a missing one: to the player the code is
    // simply dead, and every client already shows a friendly message for `no-room`. It does NOT
    // count toward the limits — a real code that's merely closed (or full, below) means they
    // already had it, which isn't a guessing signal (someone retrying a stale share link must
    // not have their connection cut).
    send(ws, { type: 'error', reason: 'no-room', code });
    return;
  }
  // A different game's room. Counted like a wrong code: to this player it IS one (and a
  // guesser sweeping codes with the wrong app id must not get free tries out of it).
  if (!appsCompatible(room.app, cleanAppId(msg.app))) {
    refuse('wrong-app');
    return;
  }
  // The host removed this connection; it can't simply walk back in. (A new connection gets a
  // new peerId and could — the host can remove it again.)
  if (room.kicked.has(ws.peerId)) {
    send(ws, { type: 'error', reason: 'kicked', code });
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

/**
 * `{type:'kick', peerId}` — the HOST removes a player. The player is told (`error: kicked`), the
 * rest of the room sees an ordinary `peer-leave`, and that connection can't re-join this room.
 * The kicked socket is NOT closed: a close would reach its app as "connection lost" and bury the
 * real reason; a v2 client hangs up by itself on `kicked`. Anything else — a guest trying it, an
 * unknown peer, the host kicking itself — is ignored without a reply (an older client would show
 * an error for one, and there's nothing the sender can do about it).
 */
function handleKick(ws, msg) {
  const room = ws.roomCode && rooms.get(ws.roomCode);
  if (!room || room.hostId !== ws.peerId) return;
  const target = typeof msg.peerId === 'string' ? room.peers.get(msg.peerId) : undefined;
  if (!target || target === ws) return;
  room.kicked.add(target.peerId);
  send(target, { type: 'error', reason: 'kicked', code: ws.roomCode });
  leaveRoom(target);
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
  // GET /whoami — what this relay sees of YOUR request: the X-Forwarded-For chain and the address
  // the rate limits would key you on. Only ever the caller's own request, so nothing leaks. It is
  // how to calibrate XFF_TRUSTED_HOPS after a deploy: send a made-up X-Forwarded-For and count
  // how many entries the proxies added after it.
  if (req.url === '/whoami') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(
      JSON.stringify({
        xForwardedFor: req.headers['x-forwarded-for'] ?? null,
        socket: normalizeIp(req.socket.remoteAddress),
        trustedHops: XFF_TRUSTED_HOPS,
        keyedOn: clientIp(req),
        protocol: PROTOCOL_VERSION,
      }) + '\n',
    );
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Mojigames relay server — ok\n');
});

const wss = new WebSocketServer({ server: httpServer, maxPayload: 1 << 20 });

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  if (!ipAllowed(ip)) {
    ws.close(1008, 'too many connections, slow down');
    return;
  }

  ws.clientIp = ip;
  ws.peerId = crypto.randomUUID();
  ws.roomCode = null;
  ws.failedJoins = 0;
  ws.isAlive = true;
  // App-level heartbeat bookkeeping (see the heartbeat section below): when this client last
  // sent us anything at all, and whether it has ever sent an app-level ping.
  ws.lastHeardAt = Date.now();
  ws.sendsPings = false;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    // Any frame at all proves the client's app is running — even one we can't parse.
    ws.lastHeardAt = Date.now();
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
      case 'kick':
        handleKick(ws, msg);
        break;
      case 'ping':
        ws.sendsPings = true; // from now on this socket is policed for silence
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
//
// ⚠️ On the live deployment this protocol-level ping does NOT work, and nothing here can tell.
// Something in front of Render (it answers as Cloudflare) swallows the ping frames before they
// reach the client — and, since no socket is ever dropped, evidently answers them too (measured
// 2026-09-24: two idle sockets received 0 pings in 15 minutes, and a frozen client was never
// dropped in 180 s, where a local relay dropped it in ~59 s).
// It is kept because it still works wherever the relay is reached directly (local dev, a plain
// VPS), and old clients rely on nothing else. The app-level heartbeat below is what works on Render.
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

// App-level heartbeat. A client that sends `{type:'ping'}` (OnlineTransport does, every 15 s
// while its socket is open, since 2026-09-24) is promising to keep talking; once it has pinged
// even once, HEARTBEAT_TIMEOUT_MS of total silence means its app is no longer running — the phone
// went to sleep, the app was backgrounded (React Native pauses JS timers there), or the network
// silently vanished. Terminate it so the rest of the room gets the usual `peer-leave`: without
// this, a host whose phone slept left every guest waiting forever, and a turn-based game hung on
// the missing player's turn.
//
// Sockets that have never pinged are left strictly alone. That is every client built before this
// change (HitMoji on Google Play, Mojino build 4, Mojiventure), and they must behave exactly as
// they always have — they would be dropped after HEARTBEAT_TIMEOUT_MS of an ordinary quiet lobby otherwise.
//
// The cost, for the record: the rule cannot tell "asleep" from "in another app for a minute". A
// host who leaves the app for longer than the limit — e.g. to send the code in WhatsApp — loses
// the room, and their guests are told the host left. Raise HEARTBEAT_TIMEOUT_MS if that bites.
// A bonus: those 15 s pings are inbound traffic, so Render's free instance no longer falls
// asleep under an open room.
const silenceSweep = setInterval(() => {
  const now = Date.now();
  for (const ws of wss.clients) {
    if (ws.sendsPings && now - ws.lastHeardAt > HEARTBEAT_TIMEOUT_MS) {
      leaveRoom(ws); // tell the room now; the `close` event's own leaveRoom is then a no-op
      ws.terminate();
    }
  }
}, SILENCE_SWEEP_MS);
wss.on('close', () => clearInterval(silenceSweep));

// Forget IPs that have gone quiet, so this map doesn't grow forever.
const rateLimitSweep = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of connectionCounts) {
    if (now - entry.windowStart > CONNECTION_WINDOW_MS) connectionCounts.delete(ip);
  }
  for (const [ip, entry] of failedJoins) {
    if (now - entry.windowStart > FAILED_JOIN_WINDOW_MS && entry.blockedUntil <= now) failedJoins.delete(ip);
  }
}, CONNECTION_WINDOW_MS);
wss.on('close', () => clearInterval(rateLimitSweep));

httpServer.listen(PORT, () => {
  console.log(`Mojigames relay server listening on :${PORT}`);
});
