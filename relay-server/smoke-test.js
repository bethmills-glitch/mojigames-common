// Smoke test for the relay server. Start the server first (npm start), then in another
// shell run `npm run smoke-test`. It exercises the whole protocol — host, join, relay
// both directions, ping/pong, the room-full and unknown-code errors, peer-leave, and a room
// closing when its host leaves; and protocol v2 (2026-10-10): 6-character codes for v2 hosts,
// 4 for legacy ones, the app-id rules (wrong-app, the legacy-join transition, Mojiventure's
// strictness), kick, rate limits keyed on X-Forwarded-For, and the per-address wrong-code pause —
// against a running server, and exits non-zero if any check fails.
// Don't point it at the LIVE relay: it deliberately trips rate limits. It doubles as a worked example of the wire protocol for the client (packages/multiplayer).
// The timing rules (dropping a client that stops pinging) are covered by reliability-test.js,
// which starts its own relay with a short limit.

const http = require('http');
const WebSocket = require('ws');

const URL = process.env.RELAY_URL || 'ws://localhost:8787';
// Must match the running server's settings (server.js reads the same env var).
const MAX_FAILED_JOINS_PER_IP = Number(process.env.MAX_FAILED_JOINS_PER_IP) || 20;
const CODE_CHARS = /^[ACDEFGHJKMNPQRSTUVWXYZ2-9]+$/;

/** A random private-range address, so each run (and each group) gets rate-limit buckets of its own. */
const fakeIp = () =>
  `10.${1 + Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 256)}.${1 + Math.floor(Math.random() * 250)}`;

/** GET a path on the relay's HTTP side; resolves to the parsed JSON body. */
function getJson(path, headers = {}) {
  const httpUrl = URL.replace(/^ws/, 'http');
  return new Promise((resolve, reject) => {
    http
      .get(new globalThis.URL(path, httpUrl), { headers }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', reject);
  });
}
let failures = 0;

function check(label, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures += 1;
}

/** Open a connection; resolves to a helper with send(), next() (awaitable inbox), close().
 *  `xff` sets an X-Forwarded-For header, as Render's proxy would. */
function connect(xff) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL, xff ? { headers: { 'X-Forwarded-For': xff } } : undefined);
    const queue = [];
    const waiters = [];
    let closed = false;
    const closeWaiters = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const waiter = waiters.shift();
      if (waiter) waiter(msg);
      else queue.push(msg);
    });
    ws.on('close', () => {
      closed = true;
      while (closeWaiters.length) closeWaiters.shift()();
    });
    ws.on('error', reject);
    ws.on('open', () =>
      resolve({
        send: (m) => ws.send(JSON.stringify(m)),
        next: () =>
          new Promise((res) => {
            const queued = queue.shift();
            if (queued) res(queued);
            else waiters.push(res);
          }),
        close: () => ws.close(),
        // Resolves to the next message, or null if none arrives within `ms` (for "nothing happens").
        nextWithin: (ms = 300) =>
          new Promise((res) => {
            const queued = queue.shift();
            if (queued) return res(queued);
            const timer = setTimeout(() => {
              const i = waiters.indexOf(waiter);
              if (i >= 0) waiters.splice(i, 1);
              res(null);
            }, ms);
            const waiter = (m) => {
              clearTimeout(timer);
              res(m);
            };
            waiters.push(waiter);
          }),
        // Resolves once the server closes this connection (already-closed resolves at once).
        waitForClose: (timeoutMs = 1000) =>
          new Promise((res) => {
            if (closed) return res(true);
            const timer = setTimeout(() => res(false), timeoutMs);
            closeWaiters.push(() => {
              clearTimeout(timer);
              res(true);
            });
          }),
      }),
    );
  });
}

(async () => {
  // Host creates a room — heartbeating first, as OnlineTransport does.
  const host = await connect();
  host.send({ type: 'ping' });
  const pong = await host.next();
  check('an app-level ping is answered with pong', pong.type === 'pong');
  host.send({ type: 'host', size: 2 });
  const hosted = await host.next();
  check(
    'host receives a 4-character room code',
    hosted.type === 'hosted' &&
      typeof hosted.code === 'string' &&
      hosted.code.length === 4,
  );

  // Guest joins by code.
  const guest = await connect();
  guest.send({ type: 'join', code: hosted.code });
  const joined = await guest.next();
  check(
    'guest joins the room',
    joined.type === 'joined' && joined.code === hosted.code,
  );
  const peerJoin = await host.next();
  check(
    'host is notified the guest joined',
    peerJoin.type === 'peer-join' && peerJoin.peerId === joined.peerId,
  );

  // Relay host → guest.
  host.send({ type: 'msg', data: { hello: 'from host' } });
  const toGuest = await guest.next();
  check(
    'guest receives the relayed message, tagged with the sender',
    toGuest.type === 'msg' &&
      toGuest.from === hosted.peerId &&
      toGuest.data.hello === 'from host',
  );

  // Relay guest → host.
  guest.send({ type: 'msg', data: { reply: 42 } });
  const toHost = await host.next();
  check(
    'host receives the reply',
    toHost.type === 'msg' && toHost.data.reply === 42,
  );

  // Unknown code is rejected.
  const stray = await connect();
  stray.send({ type: 'join', code: 'ZZZZ' });
  const noRoom = await stray.next();
  check(
    'joining an unknown code returns a no-room error',
    noRoom.type === 'error' && noRoom.reason === 'no-room',
  );

  // Repeated wrong-code guessing on the SAME connection gets rate-limited (4 more, for 5
  // total — MAX_FAILED_JOINS_PER_CONNECTION in server.js).
  for (let i = 0; i < 4; i++) {
    stray.send({ type: 'join', code: 'ZZZZ' });
    await stray.next();
  }
  check(
    'a connection that keeps guessing wrong codes gets closed by the server',
    await stray.waitForClose(),
  );

  // A third client cannot join a full 2-player room.
  const third = await connect();
  third.send({ type: 'join', code: hosted.code });
  const full = await third.next();
  check(
    'joining a full room returns a room-full error',
    full.type === 'error' && full.reason === 'room-full',
  );
  third.close();

  // Leaving notifies the remaining peer.
  guest.close();
  const peerLeave = await host.next();
  check(
    'host is notified when the guest leaves',
    peerLeave.type === 'peer-leave' && peerLeave.peerId === joined.peerId,
  );
  host.close();

  // A room closes when its HOST leaves: the guests still in it are told as always, but the
  // code stops working — a newcomer must not be seated in a room nobody can ever start.
  const host2 = await connect();
  host2.send({ type: 'host', size: 3 });
  const hosted2 = await host2.next();
  const stranded = await connect();
  stranded.send({ type: 'join', code: hosted2.code });
  await stranded.next(); // joined
  await host2.next(); // peer-join
  host2.close();
  const hostGone = await stranded.next();
  check(
    'a guest is notified when the host leaves',
    hostGone.type === 'peer-leave' && hostGone.peerId === hosted2.peerId,
  );
  const newcomer = await connect();
  newcomer.send({ type: 'join', code: hosted2.code });
  const refused = await newcomer.next();
  check(
    'joining a room whose host has left returns a no-room error',
    refused.type === 'error' && refused.reason === 'no-room',
  );
  newcomer.close();
  stranded.close();


  // ── Protocol v2 (2026-10-10) ──────────────────────────────────────────────────────────
  // Each group connects under its own made-up X-Forwarded-For address, so none of them eats into
  // another's (or the legacy checks' 127.0.0.1) rate-limit budget.

  /** Host a room as `opts` ({v, app}) from address `ip`; resolves to {client, code, peerId}. */
  async function hostRoom(ip, opts = {}) {
    const client = await connect(ip);
    client.send({ type: 'host', size: 8, ...opts });
    const msg = await client.next();
    return { client, code: msg.code, peerId: msg.peerId };
  }
  /** One join attempt on a fresh connection; resolves to the relay's answer (the socket is closed). */
  async function tryJoin(ip, code, app) {
    const guest = await connect(ip);
    guest.send(app === undefined ? { type: 'join', code } : { type: 'join', code, app });
    const answer = await guest.next();
    guest.close();
    return answer;
  }
  const joinedOk = (m) => m.type === 'joined';
  const wrongApp = (m) => m.type === 'error' && m.reason === 'wrong-app';

  {
    const ip = fakeIp();
    const legacy = await hostRoom(ip);
    check(
      'a legacy host (no v) still gets a 4-character code',
      legacy.code.length === 4 && CODE_CHARS.test(legacy.code),
    );
    const v2 = await hostRoom(ip, { v: 2 });
    check(
      'a v2 host gets a 6-character code from the same alphabet',
      v2.code.length === 6 && CODE_CHARS.test(v2.code),
    );
    check(
      'a 6-character code can be joined (typed in lower case, with a space)',
      joinedOk(await tryJoin(ip, `${v2.code.slice(0, 3).toLowerCase()} ${v2.code.slice(3)}`)),
    );
    check('a 4-character code can still be joined', joinedOk(await tryJoin(ip, legacy.code)));
    legacy.client.close();
    v2.client.close();
  }

  // The app-id matrix. "legacy" = no app id (every build before v2).
  {
    const ip = fakeIp();
    const kids = await hostRoom(ip, { v: 2, app: 'mojiventure' });
    const casino = await hostRoom(ip, { v: 2, app: 'mojino' });
    const clip = await hostRoom(ip, { v: 2, app: 'cracktheclip' });
    const old = await hostRoom(ip); // a legacy host: no v, no app

    check('mojiventure guest → mojiventure room: joins', joinedOk(await tryJoin(ip, kids.code, 'mojiventure')));
    check('mojino guest → mojiventure room: wrong-app', wrongApp(await tryJoin(ip, kids.code, 'mojino')));
    check('legacy guest → mojiventure room: wrong-app (kids rooms are strict)', wrongApp(await tryJoin(ip, kids.code)));
    check('mojino guest → mojino room: joins', joinedOk(await tryJoin(ip, casino.code, 'mojino')));
    check('legacy guest → mojino room: joins (transition)', joinedOk(await tryJoin(ip, casino.code)));
    check('mojiventure guest → mojino room: wrong-app', wrongApp(await tryJoin(ip, casino.code, 'mojiventure')));
    check('cracktheclip guest → mojino room: wrong-app', wrongApp(await tryJoin(ip, casino.code, 'cracktheclip')));
    check('legacy guest → cracktheclip room: joins (transition)', joinedOk(await tryJoin(ip, clip.code)));
    check('cracktheclip guest → legacy room: joins (transition)', joinedOk(await tryJoin(ip, old.code, 'CrackTheClip')));
    check('mojiventure guest → legacy room: wrong-app (never an app-less room)', wrongApp(await tryJoin(ip, old.code, 'mojiventure')));
    check('legacy guest → legacy room: joins, as always', joinedOk(await tryJoin(ip, old.code)));
    check(
      'a wrong-app answer does not reveal the room\'s game',
      Object.keys(await tryJoin(ip, kids.code, 'mojino')).sort().join() === 'code,reason,type',
    );
    for (const r of [kids, casino, clip, old]) r.client.close();
  }

  // Kick: only the host can, the player is told, the room sees a peer-leave, and the same
  // connection can't walk back in.
  {
    const ip = fakeIp();
    const room = await hostRoom(ip, { v: 2, app: 'mojiventure' });
    const kid = await connect(ip);
    kid.send({ type: 'join', code: room.code, app: 'mojiventure' });
    const kidJoined = await kid.next();
    await room.client.next(); // peer-join
    const other = await connect(ip);
    other.send({ type: 'join', code: room.code, app: 'mojiventure' });
    await other.next(); // joined
    await room.client.next(); // peer-join
    await kid.next(); // peer-join (other)

    // A guest trying to kick the host is ignored: nothing reaches anyone.
    other.send({ type: 'kick', peerId: room.peerId });
    check('a guest cannot kick (ignored, no reply)', (await other.nextWithin()) === null && (await room.client.nextWithin()) === null);

    room.client.send({ type: 'kick', peerId: kidJoined.peerId });
    const told = await kid.next();
    check('a kicked player is told (error: kicked)', told.type === 'error' && told.reason === 'kicked');
    const hostSaw = await room.client.next();
    const otherSaw = await other.next();
    check(
      'the room sees an ordinary peer-leave for the kicked player',
      hostSaw.type === 'peer-leave' && hostSaw.peerId === kidJoined.peerId &&
        otherSaw.type === 'peer-leave' && otherSaw.peerId === kidJoined.peerId,
    );
    kid.send({ type: 'join', code: room.code, app: 'mojiventure' });
    const back = await kid.next();
    check('the kicked connection cannot re-join that room', back.type === 'error' && back.reason === 'kicked');
    kid.send({ type: 'msg', data: 'hi' });
    const notIn = await kid.next();
    check('…and is no longer in it', notIn.type === 'error' && notIn.reason === 'not-in-room');
    for (const c of [kid, other, room.client]) c.close();
  }

  // Which address the limits key on: the first X-Forwarded-For hop (or, with XFF_TRUSTED_HOPS=N
  // on the server, the Nth from the right), falling back to the socket's own address.
  {
    const a = await getJson('/whoami', { 'X-Forwarded-For': '203.0.113.9, 198.51.100.7' });
    const expectA = a.trustedHops > 0 ? ['203.0.113.9', '198.51.100.7'][2 - a.trustedHops] : '203.0.113.9';
    check(`/whoami keys on the X-Forwarded-For client hop (${a.keyedOn})`, a.keyedOn === expectA);
    const b = await getJson('/whoami', { 'X-Forwarded-For': 'not-an-address' });
    check('a malformed X-Forwarded-For falls back to the socket address', b.keyedOn === b.socket);
    const c = await getJson('/whoami');
    check('no X-Forwarded-For → the socket address', c.keyedOn === c.socket && c.xForwardedFor === null);
  }

  // The connection limit is per CLIENT now, not per proxy: one address hitting it leaves the next
  // address untouched. (Before, behind Render, everyone shared the proxy's single bucket.)
  {
    const busy = fakeIp();
    const opened = [];
    for (let i = 0; i < 20; i++) opened.push(await connect(busy));
    const over = await connect(busy);
    check('a 21st connection in 10 s from one address is closed', await over.waitForClose());
    const neighbour = await connect(fakeIp());
    neighbour.send({ type: 'ping' });
    const answered = await neighbour.nextWithin(1000);
    check('…while a different address behind the same proxy is unaffected', answered && answered.type === 'pong');
    for (const c of [...opened, neighbour]) c.close();
  }

  // Too many wrong codes from one address pauses ALL its joins — spread over several
  // connections (each stays under the per-connection limit of 5), and even for a real code.
  {
    const guesser = fakeIp();
    const room = await hostRoom(fakeIp(), { v: 2 });
    let wrong = 0;
    while (wrong < MAX_FAILED_JOINS_PER_IP) {
      const c = await connect(guesser);
      for (let i = 0; i < 4 && wrong < MAX_FAILED_JOINS_PER_IP; i++, wrong++) {
        c.send({ type: 'join', code: 'ZZZZZZ' });
        await c.next();
      }
      c.close();
    }
    const blocked = await tryJoin(guesser, room.code);
    check(
      `after ${MAX_FAILED_JOINS_PER_IP} wrong codes, that address gets too-many-tries — even for a real code`,
      blocked.type === 'error' && blocked.reason === 'too-many-tries',
    );
    check('…while another address still joins the same room', joinedOk(await tryJoin(fakeIp(), room.code)));
    room.client.close();
  }

  console.log(
    failures === 0
      ? '\nAll relay checks passed.'
      : `\n${failures} check(s) failed.`,
  );
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('smoke test crashed:', err.message);
  console.error('(is the server running? `npm start` in packages/relay-server)');
  process.exit(1);
});
