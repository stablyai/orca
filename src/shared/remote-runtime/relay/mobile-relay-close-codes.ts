export const MOBILE_RELAY_CLOSE_CODE = {
  BAD_OUTER_CREDENTIAL: 4401,
  HOST_OFFLINE: 4404,
  PEER_DROPPED: 4408,
  WRONG_CELL: 4409,
  LIMIT_EXCEEDED: 4429,
  DRAINING: 4503
} as const

// Mirror cloud/packages/relay-contract RELAY_PHONE_CLOSE_REASON for phone sockets, distinct from host control closes. Older peers omit unknown reasons.
export const MOBILE_RELAY_PHONE_CLOSE_REASON = {
  // 4404 with live control but missed data attach deadline; allow one quick same-cell redial.
  HOST_ATTACH_TIMEOUT: 'attach-timeout'
} as const
