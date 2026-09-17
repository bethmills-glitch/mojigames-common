// useParty tests — the N-player party hook, driven over a fake in-memory `Transport` so the
// roster lifecycle (hello/roster/leave), host-authoritative start, and progress collection
// are exercised with no real network. Rendered with react-test-renderer (no DOM needed).

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import type { Transport, TransportEvent, TransportListener } from './types';
import { HOST_ID, useParty, type Party } from './use-party';

// ── A fake Transport: records sends, lets the test fire inbound events ─────────────────────
function createFakeTransport() {
  const listeners = new Set<TransportListener>();
  const sent: unknown[] = [];
  let hostSize: number | undefined;
  let joinedCode: string | undefined;
  const transport: Transport = {
    host: (o) => {
      hostSize = o?.size;
    },
    join: (c) => {
      joinedCode = c;
    },
    send: (d) => {
      sent.push(d);
    },
    close: () => {},
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  return {
    transport,
    sent,
    fire: (e: TransportEvent) => act(() => listeners.forEach((l) => l(e))),
    get hostSize() {
      return hostSize;
    },
    get joinedCode() {
      return joinedCode;
    },
  };
}

type Meta = { avatar: string };
function renderParty(fake: ReturnType<typeof createFakeTransport>, self: { name: string; meta: Meta }, maxPlayers?: number) {
  let api!: Party<{ items: number[] }, { score: number }, Meta>;
  function Probe() {
    api = useParty<{ items: number[] }, { score: number }, Meta>({
      createTransport: () => fake.transport,
      self,
      maxPlayers,
    });
    return null;
  }
  act(() => {
    TestRenderer.create(React.createElement(Probe));
  });
  return () => api;
}

const lastSent = (sent: unknown[], kind: string) =>
  [...sent].reverse().find((m) => (m as { t?: string }).t === kind) as Record<string, unknown> | undefined;

describe('useParty — host', () => {
  it('seeds the roster, accepts a guest hello, and starts the match', () => {
    const fake = createFakeTransport();
    const party = renderParty(fake, { name: 'Ann', meta: { avatar: '🦊' } }, 4);

    act(() => party().host());
    expect(fake.hostSize).toBe(4);

    fake.fire({ type: 'hosting', code: 'WXYZ', selfId: 'h1' });
    expect(party().status).toBe('waiting');
    expect(party().code).toBe('WXYZ');
    expect(party().isHost).toBe(true);
    expect(party().members).toEqual([{ id: HOST_ID, name: 'Ann', meta: { avatar: '🦊' } }]);

    // A guest connects and introduces itself → roster grows + a roster broadcast goes out.
    fake.fire({ type: 'peer-join', peerId: 'g1' });
    fake.fire({ type: 'message', from: 'g1', data: { t: 'party:hello', id: 'g1', name: 'Bo', meta: { avatar: '🐼' } } });
    expect(party().members.map((m) => m.id)).toEqual([HOST_ID, 'g1']);
    expect(lastSent(fake.sent, 'party:roster')).toMatchObject({ members: [{ id: HOST_ID }, { id: 'g1' }] });

    // Host starts → broadcasts the opaque payload + frozen roster, and enters the match.
    act(() => party().start({ items: [1, 2, 3] }));
    expect(party().phase).toBe('match');
    expect(party().match?.payload).toEqual({ items: [1, 2, 3] });
    expect(lastSent(fake.sent, 'party:start')).toMatchObject({ payload: { items: [1, 2, 3] } });

    // A guest's progress is collected for the live leaderboard.
    fake.fire({ type: 'message', from: 'g1', data: { t: 'party:progress', id: 'g1', progress: { score: 50 } } });
    expect(party().progress).toEqual({ g1: { score: 50 } });

    // The guest leaves → dropped from roster + progress.
    fake.fire({ type: 'peer-leave', peerId: 'g1' });
    expect(party().members.map((m) => m.id)).toEqual([HOST_ID]);
    expect(party().progress).toEqual({});
  });

  it('prunes a departed guest even when its self-reported id differs from its transport peer id', () => {
    // On OnlineTransport a guest's own `selfId` and the id everyone else sees for it in
    // peer-join/peer-leave/message are the SAME string (the relay mints one id per socket).
    // On NearbyTransport they are NOT — each side's native stack (MultipeerConnectivity /
    // Nearby Connections) assigns its own local id for a connection, independently of the
    // other side. This test uses two DIFFERENT strings for "the same real guest" — exactly
    // like nearby-transport.test.ts's own 'guest-self' vs 'guest-1' — to prove the roster
    // still gets pruned on leave, instead of the departed guest lingering as a ghost forever.
    const fake = createFakeTransport();
    const party = renderParty(fake, { name: 'Ann', meta: { avatar: '🦊' } }, 4);

    act(() => party().host());
    fake.fire({ type: 'hosting', code: 'WXYZ', selfId: 'h1' });

    // The guest's `party:hello` is DELIVERED from transport id 'guest-1' (the host's own
    // local view of that connection), but its PAYLOAD carries the guest's self-reported id
    // 'guest-self' — the value the guest itself believes is its `selfId`.
    fake.fire({ type: 'peer-join', peerId: 'guest-1' });
    fake.fire({ type: 'message', from: 'guest-1', data: { t: 'party:hello', id: 'guest-self', name: 'Bo', meta: { avatar: '🐼' } } });
    expect(party().members.map((m) => m.id)).toEqual([HOST_ID, 'guest-self']); // seated by self-reported id, unchanged

    fake.fire({ type: 'message', from: 'guest-1', data: { t: 'party:progress', id: 'guest-self', progress: { score: 30 } } });
    expect(party().progress).toEqual({ 'guest-self': { score: 30 } });

    // The guest disconnects — the transport reports its OWN (host-side) view of the peer,
    // 'guest-1', which never matches 'guest-self' by simple equality.
    fake.fire({ type: 'peer-leave', peerId: 'guest-1' });
    expect(party().members.map((m) => m.id)).toEqual([HOST_ID]); // pruned, not a lingering ghost
    expect(party().progress).toEqual({});
    expect(lastSent(fake.sent, 'party:leave')).toMatchObject({ id: 'guest-self' }); // guests told by the id THEY know
  });

  it('turns away a hello that arrives after the match has started (no ghost roster)', () => {
    const fake = createFakeTransport();
    const party = renderParty(fake, { name: 'Ann', meta: { avatar: '🦊' } }, 4);

    act(() => party().host());
    fake.fire({ type: 'hosting', code: 'WXYZ', selfId: 'h1' });
    fake.fire({ type: 'peer-join', peerId: 'g1' });
    fake.fire({ type: 'message', from: 'g1', data: { t: 'party:hello', id: 'g1', name: 'Bo', meta: { avatar: '🐼' } } });
    act(() => party().start({ items: [1, 2, 3] }));

    // A latecomer connects AFTER start → must NOT be seated (no ghost), and is told the room is
    // closed so its own screen can bail instead of hanging on the lobby forever.
    fake.fire({ type: 'peer-join', peerId: 'late' });
    fake.fire({ type: 'message', from: 'late', data: { t: 'party:hello', id: 'late', name: 'Cy', meta: { avatar: '🐧' } } });
    expect(party().members.map((m) => m.id)).toEqual([HOST_ID, 'g1']);
    expect(lastSent(fake.sent, 'party:closed')).toMatchObject({ id: 'late', reason: 'in-progress' });
  });

  it('turns away (and tells) a hello once the room is full', () => {
    const fake = createFakeTransport();
    const party = renderParty(fake, { name: 'Ann', meta: { avatar: '🦊' } }, 2); // host + 1 only

    act(() => party().host());
    fake.fire({ type: 'hosting', code: 'WXYZ', selfId: 'h1' });
    fake.fire({ type: 'message', from: 'g1', data: { t: 'party:hello', id: 'g1', name: 'Bo', meta: { avatar: '🐼' } } });
    expect(party().members.map((m) => m.id)).toEqual([HOST_ID, 'g1']); // room now full (2/2)

    fake.fire({ type: 'message', from: 'g2', data: { t: 'party:hello', id: 'g2', name: 'Cy', meta: { avatar: '🐧' } } });
    expect(party().members.map((m) => m.id)).toEqual([HOST_ID, 'g1']); // not seated
    expect(lastSent(fake.sent, 'party:closed')).toMatchObject({ id: 'g2', reason: 'room-full' });
  });

  it('returns everyone to the lobby after a match, keeping the room and its code alive', () => {
    const fake = createFakeTransport();
    const party = renderParty(fake, { name: 'Ann', meta: { avatar: '🦊' } }, 4);

    act(() => party().host());
    fake.fire({ type: 'hosting', code: 'WXYZ', selfId: 'h1' });
    fake.fire({ type: 'message', from: 'g1', data: { t: 'party:hello', id: 'g1', name: 'Bo', meta: { avatar: '🐼' } } });
    act(() => party().start({ items: [1, 2, 3] }));
    fake.fire({ type: 'message', from: 'g1', data: { t: 'party:progress', id: 'g1', progress: { score: 50 } } });
    expect(party().phase).toBe('match');

    act(() => party().endMatch());

    // The room survives the game: same code, same roster, same socket. This is what lets one
    // party play game after game instead of the host re-hosting and everyone re-typing a code.
    expect(party().phase).toBe('lobby');
    expect(party().match).toBeNull();
    expect(party().code).toBe('WXYZ');
    expect(party().members.map((m) => m.id)).toEqual([HOST_ID, 'g1']);
    // Last game's scores must not bleed into the next game's leaderboard.
    expect(party().progress).toEqual({});
    expect(lastSent(fake.sent, 'party:lobby')).toMatchObject({ members: [{ id: HOST_ID }, { id: 'g1' }] });

    // And the room RE-OPENS. The in-progress seal used to last the life of the room, so a
    // friend whose phone dropped mid-game could never get back in.
    fake.fire({ type: 'message', from: 'g2', data: { t: 'party:hello', id: 'g2', name: 'Cy', meta: { avatar: '🐧' } } });
    expect(party().members.map((m) => m.id)).toEqual([HOST_ID, 'g1', 'g2']);
  });

  it('re-seals the room on the NEXT start, so the ghost-roster bug cannot come back', () => {
    // endMatch reopens the room; start must close it again. Without this the second game of a
    // games night would happily seat a latecomer who never receives its one-shot `party:start`.
    const fake = createFakeTransport();
    const party = renderParty(fake, { name: 'Ann', meta: { avatar: '🦊' } }, 8);

    act(() => party().host());
    fake.fire({ type: 'hosting', code: 'WXYZ', selfId: 'h1' });
    fake.fire({ type: 'message', from: 'g1', data: { t: 'party:hello', id: 'g1', name: 'Bo', meta: { avatar: '🐼' } } });
    act(() => party().start({ items: [1] }));
    act(() => party().endMatch());
    act(() => party().start({ items: [2] }));

    fake.fire({ type: 'message', from: 'late', data: { t: 'party:hello', id: 'late', name: 'Di', meta: { avatar: '🐨' } } });
    expect(party().members.map((m) => m.id)).toEqual([HOST_ID, 'g1']);
    expect(lastSent(fake.sent, 'party:closed')).toMatchObject({ id: 'late', reason: 'in-progress' });
  });

  it('ignores endMatch from a guest — returning to the lobby is the host’s call', () => {
    const fake = createFakeTransport();
    const party = renderParty(fake, { name: 'Bo', meta: { avatar: '🐼' } });

    act(() => party().join('WXYZ'));
    fake.fire({ type: 'joined', code: 'WXYZ', selfId: 'g1', peers: ['h1'] });
    const roster = [{ id: HOST_ID, name: 'Ann', meta: { avatar: '🦊' } }];
    fake.fire({ type: 'message', from: 'h1', data: { t: 'party:start', payload: { items: [1] }, members: roster } });
    expect(party().phase).toBe('match');

    act(() => party().endMatch());
    expect(party().phase).toBe('match'); // unchanged
    expect(lastSent(fake.sent, 'party:lobby')).toBeUndefined();
  });
});

describe('useParty — guest', () => {
  it('says hello on join, mirrors the roster, and enters the match on start', () => {
    const fake = createFakeTransport();
    const party = renderParty(fake, { name: 'Bo', meta: { avatar: '🐼' } });

    act(() => party().join('WXYZ'));
    expect(fake.joinedCode).toBe('WXYZ');

    fake.fire({ type: 'joined', code: 'WXYZ', selfId: 'g1', peers: ['h1'] });
    expect(party().status).toBe('connected');
    expect(party().selfId).toBe('g1');
    expect(lastSent(fake.sent, 'party:hello')).toMatchObject({ id: 'g1', name: 'Bo' });

    // Host's roster broadcast is mirrored verbatim.
    const roster = [
      { id: HOST_ID, name: 'Ann', meta: { avatar: '🦊' } },
      { id: 'g1', name: 'Bo', meta: { avatar: '🐼' } },
    ];
    fake.fire({ type: 'message', from: 'h1', data: { t: 'party:roster', members: roster } });
    expect(party().members).toEqual(roster);

    // Start message flips the guest into the match with the host's payload.
    fake.fire({ type: 'message', from: 'h1', data: { t: 'party:start', payload: { items: [7, 8] }, members: roster } });
    expect(party().phase).toBe('match');
    expect(party().match?.payload).toEqual({ items: [7, 8] });

    // The host disconnecting (peers[0]) ends the guest's session.
    fake.fire({ type: 'peer-leave', peerId: 'h1' });
    expect(party().status).toBe('error');
    expect(party().error).toBe('host-left');
  });

  it('drops the host from the roster when it leaves, so nothing waits on a departed player', () => {
    const fake = createFakeTransport();
    const party = renderParty(fake, { name: 'Bo', meta: { avatar: '🐼' } });

    act(() => party().join('WXYZ'));
    fake.fire({ type: 'joined', code: 'WXYZ', selfId: 'g1', peers: ['h1'] });

    const roster = [
      { id: HOST_ID, name: 'Ann', meta: { avatar: '🦊' } },
      { id: 'g1', name: 'Bo', meta: { avatar: '🐼' } },
    ];
    fake.fire({ type: 'message', from: 'h1', data: { t: 'party:roster', members: roster } });
    fake.fire({ type: 'message', from: 'h1', data: { t: 'party:start', payload: { items: [7, 8] }, members: roster } });
    // The host reports some progress, then quits mid-match.
    fake.fire({ type: 'message', from: 'h1', data: { t: 'party:progress', id: HOST_ID, progress: { score: 500 } } });
    expect(party().progress[HOST_ID]).toEqual({ score: 500 });

    fake.fire({ type: 'peer-leave', peerId: 'h1' });

    // Only the guest is left. If the host lingered here its row would stay frozen on the
    // leaderboard, "has everyone finished?" would never be true, and a host who quit while
    // ahead could still win.
    expect(party().members.map((m) => m.id)).toEqual(['g1']);
    expect(party().progress[HOST_ID]).toBeUndefined();
    // The frozen match roster is deliberately untouched — it is the record of who started.
    expect(party().match?.members.map((m) => m.id)).toEqual([HOST_ID, 'g1']);
  });

  it('errors when the host closes the room to it, but ignores a close aimed elsewhere', () => {
    const fake = createFakeTransport();
    const party = renderParty(fake, { name: 'Cy', meta: { avatar: '🐧' } });

    act(() => party().join('WXYZ'));
    fake.fire({ type: 'joined', code: 'WXYZ', selfId: 'late', peers: ['h1'] });
    expect(party().status).toBe('connected');

    // A close aimed at a DIFFERENT id must be ignored — a guest already in the match receives
    // the same broadcast and must not error on someone else's rejection.
    fake.fire({ type: 'message', from: 'h1', data: { t: 'party:closed', id: 'someone-else', reason: 'in-progress' } });
    expect(party().status).toBe('connected');

    // A close aimed at THIS device flips it to a showable error instead of a silent hang.
    fake.fire({ type: 'message', from: 'h1', data: { t: 'party:closed', id: 'late', reason: 'in-progress' } });
    expect(party().status).toBe('error');
    expect(party().error).toBe('match-started');
  });

  it('follows the host back to the lobby between games, without re-joining', () => {
    const fake = createFakeTransport();
    const party = renderParty(fake, { name: 'Bo', meta: { avatar: '🐼' } });

    act(() => party().join('WXYZ'));
    fake.fire({ type: 'joined', code: 'WXYZ', selfId: 'g1', peers: ['h1'] });

    const roster = [
      { id: HOST_ID, name: 'Ann', meta: { avatar: '🦊' } },
      { id: 'g1', name: 'Bo', meta: { avatar: '🐼' } },
    ];
    fake.fire({ type: 'message', from: 'h1', data: { t: 'party:start', payload: { items: [7, 8] }, members: roster } });
    fake.fire({ type: 'message', from: 'h1', data: { t: 'party:progress', id: HOST_ID, progress: { score: 90 } } });
    expect(party().phase).toBe('match');

    // The host picks "back to the lobby" — everyone lands back in the SAME party.
    const nextRoster = [...roster, { id: 'g2', name: 'Cy', meta: { avatar: '🐧' } }];
    fake.fire({ type: 'message', from: 'h1', data: { t: 'party:lobby', members: nextRoster } });

    expect(party().phase).toBe('lobby');
    expect(party().match).toBeNull();
    expect(party().status).toBe('connected'); // still in the room — no reconnect, no code re-entry
    expect(party().code).toBe('WXYZ');
    // The live roster rides along, because party:start had overwritten `members` with the
    // frozen copy — without it the lobby would show the wrong player list for the next game.
    expect(party().members.map((m) => m.id)).toEqual([HOST_ID, 'g1', 'g2']);
    expect(party().progress).toEqual({});
  });
});
