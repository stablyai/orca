// Why: shared between main (PeerClientService) and preload/renderer so the
// connection-state vocabulary for "this desktop as a peer client" stays one
// source instead of drifting between the two IPC boundary types.
export type PeerClientConnectionState = 'connecting' | 'connected' | 'reconnect-wait' | 'closed'

export type PeerClientStatus = {
  state: PeerClientConnectionState
  endpoint: string | null
  reconnectAttempt: number
  lastErrorReason: string | null
}

export type SavedPeerPairing = { hostId: string; endpoint: string | null }

// Why: one entry per PeerClientManager-tracked host connection, for the
// multi-host status list surfaced over IPC (getStatus stays single-host).
export type PeerClientStatusWithHost = PeerClientStatus & { hostId: string }
