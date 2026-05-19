// Smoke test for the relay server. Start the server first (npm start), then in another
// shell run `npm run smoke-test`. It exercises the whole protocol — host, join, relay
// both directions, the room-full and unknown-code errors, and peer-leave — against a
// running server, and exits non-zero if any check fails. It doubles as a worked example
// of the wire protocol for the client (packages/multiplayer).

const WebSocket = require('ws');

const URL = process.env.RELAY_URL || 'ws://localhost:8787';
let failures = 0;

function check(label, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures += 1;
}

/** Open a connection; resolves to a helper with send(), next() (awaitable inbox), close(). */
function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const queue = [];
    const waiters = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const waiter = waiters.shift();
      if (waiter) waiter(msg);
      else queue.push(msg);
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
      }),
    );
  });
}

(async () => {
  // Host creates a room.
  const host = await connect();
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
  stray.close();

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
