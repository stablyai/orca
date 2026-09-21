// The refusal vocabulary of a retained-payload read.
//
// It lives in shared, apart from the reader itself, so the RPC error mapper can
// allowlist these codes without pulling the journal's SQLite reader into its
// module graph. A client that receives one of them can say WHY the full content
// is unavailable — not retained, not this session's, tampered with, or a host
// too old to serve it — instead of a generic runtime failure.

export const PAYLOAD_READ_ERROR_CODES = [
  'payload_not_referenced',
  'payload_not_retained',
  'payload_integrity_failed',
  'payload_read_unsupported'
] as const

export type PayloadReadErrorCode = (typeof PAYLOAD_READ_ERROR_CODES)[number]
