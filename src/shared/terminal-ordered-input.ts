export const TERMINAL_ORDERED_INPUT_CAPABILITY = {
  version: 1,
  maxFrameBytes: 256 * 1024,
  maxPendingBytes: 1024 * 1024,
  maxPendingFrames: 64
} as const

export type TerminalInputReceipt = {
  sequence: number
  outcome: 'accepted' | 'rejected' | 'unknown'
  reason?:
    | 'queue_full'
    | 'too_large'
    | 'not_writable'
    | 'stale'
    | 'dependency_failed'
    | 'invalid_sequence'
    | 'invalid_payload'
    | 'write_failed'
}
