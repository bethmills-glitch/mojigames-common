// mojigames-common/multiplayer — the transport-agnostic multiplayer core.
//
// Public surface:
//   • Transport / TransportEvent / TransportListener / PeerId — the connection abstraction.
//   • OnlineTransport — the `online` transport (WebSocket → the relay server).
//   • useMultiplayer — the React hook that drives a 1v1 session over any Transport.
//   • useParty — the React hook that drives an N-player party (roster + start + progress).
//
// The `nearby` (in-person) transport is a separate entry point — `mojigames-common/nearby`
// — because it depends on a native module; importing it is opt-in, per game.

export type {
  PeerId,
  Transport,
  TransportEvent,
  TransportListener,
} from './types';

export { OnlineTransport } from './online-transport';
export type {
  OnlineTransportOptions,
  WebSocketCtor,
  WebSocketLike,
} from './online-transport';

export { useMultiplayer } from './use-multiplayer';
export type { Multiplayer, MultiplayerStatus } from './use-multiplayer';

export { useParty, HOST_ID, DEFAULT_MAX_PLAYERS } from './use-party';
export type { Party, PartyMember, PartyPhase, UsePartyOptions } from './use-party';
