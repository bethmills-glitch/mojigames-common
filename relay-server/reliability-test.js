// Reliability tests for the relay — the 2026-09-24 fixes, run against a REAL relay process with
// real WebSocket clients. Unlike smoke-test.js (which needs a relay already running, with the
// production timings), this starts its own relays on spare ports with a short heartbeat limit
// (HEARTBEAT_TIMEOUT_MS=1500), so the timing checks take seconds instead of minutes. Each group of
// checks gets its own relay: the relay caps new connections per IP (20 per 10 s), and every
// client here comes from 127.0.0.1.
//
//   npm run test:reliability            (in relay-server/, after npm install)
//
// What it proves:
//   • a client that has sent app-level pings and then goes silent is dropped, and its room-mates
//     are told (`peer-leave`); one that keeps talking is not;
//   • a client that never pings — every app build from before this change — is NOT dropped by
//     that rule, however long it stays quiet;
//   • a room closes when its host leaves: its guests are told as before, a newcomer gets
//     `no-room`, and retrying the dead code doesn't count as guessing;
//   • end to end with the real OnlineTransport (when this Node can load TypeScript): the relay
//     drops a frozen transport, and a transport notices a frozen relay by itself.

const { spawn } = require('child_process');
const path = require('path');
const { pathToFileURL } = require('url');
const WebSocket = require('ws');

const HEARTBEAT_TIMEOUT_MS = 1500;
const results = [];

function check(group, label, ok, detail) {
  results.push({ group, label, ok, detail });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Start a relay on a spare port; resolves once it is listening. */
async function startRelay() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      env: { ...process.env, PORT: String(port), HEARTBEAT_TIMEOUT_MS: String(HEARTBEAT_TIMEOUT_MS) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const ready = await new Promise((resolve) => {
      let settled = false;
      const done = (ok) => {
        if (!settled) {
          settled = true;
          resolve(ok);
        }
      };
      proc.stdout.on('data', (d) => {
        if (String(d).includes('listening')) done(true);
      });
      proc.on('exit', () => done(false)); // e.g. EADDRINUSE — try another port
      setTimeout(() => done(false), 5000);
    });
    if (ready) {
      return {
        url: `ws://127.0.0.1:${port}`,
        proc,
        stop: () => {
          try {
            proc.kill('SIGCONT'); // in case a test froze it
            proc.kill();
          } catch {
            /* already gone */
          }
        },
      };
    }
    proc.kill();
  }
  throw new Error('could not start a relay');
}

/** A raw protocol client: send(), next() (awaitable inbox, with a timeout), close tracking. */
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const queue = [];
    const waiters = [];
    const client = {
      closedAt: null,
      lastSentAt: 0,
      send(msg) {
        client.lastSentAt = Date.now();
        ws.send(JSON.stringify(msg));
      },
      /** The next message, or null if none arrives within `timeoutMs`. */
      next(timeoutMs = 2000) {
        return new Promise((res) => {
          if (queue.length) return res(queue.shift());
          const waiter = { res, timer: setTimeout(() => {
            waiters.splice(waiters.indexOf(waiter), 1);
            res(null);
          }, timeoutMs) };
          waiters.push(waiter);
        });
      },
      /** Resolves true once the server has closed this connection, false on timeout. */
      waitForClose(timeoutMs) {
        return new Promise((res) => {
          if (client.closedAt) return res(true);
          const started = Date.now();
          const poll = setInterval(() => {
            if (client.closedAt) {
              clearInterval(poll);
              res(true);
            } else if (Date.now() - started > timeoutMs) {
              clearInterval(poll);
              res(false);
            }
          }, 20);
        });
      },
      isOpen: () => ws.readyState === WebSocket.OPEN,
      close: () => ws.close(),
    };
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const waiter = waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.res(msg);
      } else {
        queue.push(msg);
      }
    });
    ws.on('close', () => {
      client.closedAt = Date.now();
    });
    ws.on('error', reject);
    ws.on('open', () => resolve(client));
  });
}

/** Read messages until one matches `pred` (or give up after `timeoutMs`). */
async function nextMatching(client, pred, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return null;
    const msg = await client.next(left);
    if (!msg) return null;
    if (pred(msg)) return msg;
  }
}

async function hostRoom(url, size = 4, { ping = false } = {}) {
  const host = await connect(url);
  if (ping) {
    host.send({ type: 'ping' });
    await host.next();
  }
  host.send({ type: 'host', size });
  const hosted = await nextMatching(host, (m) => m.type === 'hosted');
  return { host, code: hosted.code, hostPeerId: hosted.peerId };
}

async function joinRoom(url, code) {
  const guest = await connect(url);
  guest.send({ type: 'join', code });
  const reply = await guest.next();
  return { guest, reply };
}

// ── Heartbeat: who gets dropped ─────────────────────────────────────────────────────────────

async function heartbeatGroup() {
  const G = 'heartbeat';
  const relay = await startRelay();
  try {
    // A heartbeat-aware host whose app then freezes (it simply stops sending), with an OLD-STYLE
    // guest in its room that never pings at all.
    const { host, code, hostPeerId } = await hostRoom(relay.url, 4, { ping: true });
    const { guest, reply } = await joinRoom(relay.url, code);
    check(G, 'an old-style guest joins a heartbeat-aware host', reply && reply.type === 'joined');
    await nextMatching(host, (m) => m.type === 'peer-join');
    const frozeAt = host.lastSentAt;

    const leave = await nextMatching(guest, (m) => m.type === 'peer-leave', HEARTBEAT_TIMEOUT_MS * 3);
    const after = Date.now() - frozeAt;
    check(G, 'a client that pinged and then went silent is dropped, and its room is told (peer-leave)',
      leave && leave.peerId === hostPeerId, leave ? '' : 'no peer-leave arrived');
    check(G, `…after the limit, not before (${after} ms; limit ${HEARTBEAT_TIMEOUT_MS} ms)`,
      after >= HEARTBEAT_TIMEOUT_MS - 100 && after <= HEARTBEAT_TIMEOUT_MS * 2 + 500);
    check(G, 'the dropped client’s own connection is closed by the relay', await host.waitForClose(1000));

    // The old-style guest stays silent for well over twice the limit — and must survive it.
    await sleep(HEARTBEAT_TIMEOUT_MS * 2.5);
    check(G, 'a client that never pings is NOT dropped, however long it stays quiet', guest.isOpen() && !guest.closedAt);
    guest.send({ type: 'host', size: 2 }); // and it still works
    const hosted = await nextMatching(guest, (m) => m.type === 'hosted');
    check(G, '…and still works afterwards', !!hosted);
    guest.close();

    // A heartbeat-aware client that keeps pinging is never dropped.
    const pinger = await connect(relay.url);
    const pingLoop = setInterval(() => pinger.send({ type: 'ping' }), 400);
    pinger.send({ type: 'ping' });
    await sleep(HEARTBEAT_TIMEOUT_MS * 2.5);
    clearInterval(pingLoop);
    check(G, 'a client that keeps pinging stays connected', pinger.isOpen());
    pinger.close();

    // Any frame is a sign of life, not just a ping: a client that pinged once and then only
    // sends game messages is fine.
    const { host: chatty } = await hostRoom(relay.url, 4, { ping: true });
    const chatLoop = setInterval(() => chatty.send({ type: 'msg', data: { hi: 1 } }), 400);
    await sleep(HEARTBEAT_TIMEOUT_MS * 2.5);
    clearInterval(chatLoop);
    check(G, 'any message counts as a sign of life, not only pings', chatty.isOpen());
    chatty.close();
  } finally {
    relay.stop();
  }
}

// ── Rooms close when their host leaves ─────────────────────────────────────────────────────

async function roomGroup() {
  const G = 'rooms';
  const relay = await startRelay();
  try {
    const { host, code, hostPeerId } = await hostRoom(relay.url, 4);
    const a = await joinRoom(relay.url, code);
    const b = await joinRoom(relay.url, code);
    check(G, 'two guests join', a.reply.type === 'joined' && b.reply.type === 'joined');

    host.close();
    const leaveA = await nextMatching(a.guest, (m) => m.type === 'peer-leave');
    const leaveB = await nextMatching(b.guest, (m) => m.type === 'peer-leave');
    check(G, 'when the host leaves, every guest is told exactly as before (peer-leave)',
      leaveA && leaveA.peerId === hostPeerId && leaveB && leaveB.peerId === hostPeerId);

    const late = await joinRoom(relay.url, code);
    check(G, 'a newcomer with the same code is refused like a missing room (no-room)',
      late.reply && late.reply.type === 'error' && late.reply.reason === 'no-room' && late.reply.code === code);

    a.guest.send({ type: 'msg', data: { still: 'here' } });
    const relayed = await nextMatching(b.guest, (m) => m.type === 'msg');
    check(G, 'the stranded guests can still reach each other, as before', relayed && relayed.data.still === 'here');

    for (let i = 0; i < 6; i++) {
      late.guest.send({ type: 'join', code });
      await late.guest.next();
    }
    check(G, 'retrying a dead code is not treated as code-guessing (connection stays open)', late.guest.isOpen());
    for (let i = 0; i < 5; i++) {
      late.guest.send({ type: 'join', code: 'ZZZZ' });
      await late.guest.next();
    }
    check(G, '…while wrong codes still are (closed after 5)', await late.guest.waitForClose(1000));

    a.guest.close();
    b.guest.close();
    await sleep(100);
    const gone = await joinRoom(relay.url, code);
    check(G, 'once the last guest leaves the room is gone entirely', gone.reply.type === 'error' && gone.reply.reason === 'no-room');
    gone.guest.close();

    // A GUEST leaving does not close the room.
    const r2 = await hostRoom(relay.url, 4);
    const g1 = await joinRoom(relay.url, r2.code);
    g1.guest.close();
    await nextMatching(r2.host, (m) => m.type === 'peer-leave');
    const g2 = await joinRoom(relay.url, r2.code);
    check(G, 'a guest leaving does not close the room', g2.reply.type === 'joined');

    // A host that hosts again from the same connection closes its old room.
    r2.host.send({ type: 'host', size: 4 });
    const rehosted = await nextMatching(r2.host, (m) => m.type === 'hosted');
    const told = await nextMatching(g2.guest, (m) => m.type === 'peer-leave');
    const g3 = await joinRoom(relay.url, r2.code);
    check(G, 'a host that re-hosts closes its old room (guests told, code dead)',
      rehosted && rehosted.code !== r2.code && !!told && g3.reply.type === 'error' && g3.reply.reason === 'no-room');
    for (const c of [r2.host, g2.guest, g3.guest]) c.close();
  } finally {
    relay.stop();
  }
}

// ── End to end with the real OnlineTransport ────────────────────────────────────────────────

async function loadOnlineTransport() {
  if (!(process.features && process.features.typescript)) return null;
  // Loading .ts from a package without "type": "module" prints a harmless module-type warning.
  process.removeAllListeners('warning');
  const file = path.join(__dirname, '..', 'src', 'multiplayer', 'online-transport.ts');
  const mod = await import(pathToFileURL(file).href);
  return mod.OnlineTransport;
}

/** Collect a transport's events; `until(pred, ms)` waits for one matching `pred`. */
function watch(transport) {
  const events = [];
  const listeners = [];
  transport.subscribe((e) => {
    events.push({ ...e, at: Date.now() });
    for (const l of listeners.splice(0)) l();
  });
  return {
    events,
    until(pred, timeoutMs) {
      return new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs;
        const test = () => {
          const hit = events.find(pred);
          if (hit) return resolve(hit);
          if (Date.now() > deadline) return resolve(null);
          listeners.push(test);
          setTimeout(test, Math.max(10, deadline - Date.now()));
        };
        test();
      });
    },
  };
}

async function transportGroup(OnlineTransport) {
  const G = 'OnlineTransport end to end';
  const relay = await startRelay();
  try {
    const fast = { WebSocketImpl: WebSocket, pingIntervalMs: 300, deadAfterMs: 1000 };

    // A frozen host: it pings once as its socket opens (so the relay polices it) and then never
    // again — a phone that went to sleep. Its guest heartbeats normally.
    const host = new OnlineTransport({ url: relay.url, ...fast, pingIntervalMs: 600_000, deadAfterMs: 600_000 });
    const guest = new OnlineTransport({ url: relay.url, ...fast });
    const hw = watch(host);
    const gw = watch(guest);
    host.host({ size: 4 });
    const hosting = await hw.until((e) => e.type === 'hosting', 3000);
    guest.join(hosting.code);
    const joined = await gw.until((e) => e.type === 'joined', 3000);
    check(G, 'a guest joins a host over the real transport', !!joined && joined.peers[0] === hosting.selfId);

    const left = await gw.until((e) => e.type === 'peer-leave', HEARTBEAT_TIMEOUT_MS * 3);
    check(G, 'the relay drops a host whose app froze, and the guest is told', !!left && left.peerId === hosting.selfId);
    const lost = await hw.until((e) => e.type === 'error', 2000);
    check(G, 'the frozen host itself sees connection-lost once it can look', !!lost && lost.reason === 'connection-lost');

    // The guest kept heartbeating all along, so it is still connected well past the limit.
    await sleep(HEARTBEAT_TIMEOUT_MS * 1.5);
    check(G, 'a heartbeating transport outlives the limit several times over',
      !gw.events.some((e) => e.type === 'error' || e.type === 'closed'));
    guest.close();

    // The other half: the RELAY freezes (SIGSTOP), and a transport notices by itself — no close
    // ever arrives from a frozen peer, which is exactly the half-open link this guards against.
    const solo = new OnlineTransport({ url: relay.url, ...fast });
    const sw = watch(solo);
    solo.host({ size: 2 });
    await sw.until((e) => e.type === 'hosting', 3000);
    const frozeAt = Date.now();
    relay.proc.kill('SIGSTOP');
    const dead = await sw.until((e) => e.type === 'error', 5000);
    relay.proc.kill('SIGCONT');
    const took = dead ? dead.at - frozeAt : -1;
    check(G, `a transport declares a silent relay dead by itself (${took} ms; limit ${fast.deadAfterMs} ms)`,
      !!dead && dead.reason === 'connection-lost' && took >= fast.deadAfterMs - 400 && took <= fast.deadAfterMs + 1500);
    check(G, '…and reports it exactly like a dropped link (error, then closed)',
      sw.events.some((e) => e.type === 'closed'));
    solo.close();
  } finally {
    relay.stop();
  }
}

(async () => {
  const OnlineTransport = await loadOnlineTransport().catch((err) => {
    console.log(`(skipping the OnlineTransport checks: ${err.message})`);
    return null;
  });
  await Promise.all([
    heartbeatGroup(),
    roomGroup(),
    OnlineTransport ? transportGroup(OnlineTransport) : Promise.resolve(),
  ]);
  if (!OnlineTransport) {
    console.log('(OnlineTransport checks skipped: this Node cannot load TypeScript — needs Node 22.18+ / 23.6+)');
  }

  // The groups ran side by side; print each one's checks together, in the order they ran.
  const order = [...new Set(results.map((r) => r.group))];
  results.sort((x, y) => order.indexOf(x.group) - order.indexOf(y.group));
  let failures = 0;
  let group = '';
  for (const r of results) {
    if (r.group !== group) {
      group = r.group;
      console.log(`\n${group}`);
    }
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.label}${!r.ok && r.detail ? ` — ${r.detail}` : ''}`);
    if (!r.ok) failures += 1;
  }
  console.log(failures === 0 ? `\nAll ${results.length} reliability checks passed.` : `\n${failures} of ${results.length} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('reliability test crashed:', err);
  process.exit(1);
});
