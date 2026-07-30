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

export type SavedPeerPairing = { endpoint: string | null }
