// Why: the host closes a second peer socket with this code when its deviceId
// already has a live peer connection (a pasted pairing code shared with two
// clients) — distinct from E2EEChannel's 4001 so the client can tell "this
// code is already in use" apart from a rejected/invalid pairing.
export const PEER_DUPLICATE_CONNECTION_CLOSE_CODE = 4010

// Why: the host closes (or rejects) a peer socket with this code when the
// user has peer hosting toggled off — lets the client latch closed instead
// of retrying a rejection that will repeat until the host re-enables it.
export const PEER_HOSTING_DISABLED_CLOSE_CODE = 4011

// Why: the host user pressed disconnect on this client. Distinct from a
// network drop (1006) so the client latches closed instead of auto-reconnecting,
// which would undo the host's action a second later.
export const PEER_HOST_DISCONNECTED_CLOSE_CODE = 4012
