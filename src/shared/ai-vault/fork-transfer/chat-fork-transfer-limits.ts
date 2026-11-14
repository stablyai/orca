// 256 KiB stays well under every transport's 1 MiB frame cap after base64 and sealing.
export const CHAT_FORK_TRANSFER_CHUNK_BYTES = 256 * 1024
export const CHAT_FORK_TRANSFER_MAX_BYTES = 64 * 1024 * 1024
export const CHAT_FORK_TRANSFER_IDLE_MS = 10 * 60 * 1000
/** Each of open exports, open imports and placed-but-unlaunched imports. */
export const CHAT_FORK_TRANSFER_MAX_SESSIONS = 4
export const CHAT_FORK_TRANSFER_CHUNK_BASE64_MAX_CHARS =
  Math.ceil(CHAT_FORK_TRANSFER_CHUNK_BYTES / 3) * 4 + 8

/** Hosts reply with these as the error message; clients branch on them. */
export const CHAT_FORK_TRANSFER_ERROR_CODES = [
  'chat_fork_transfer_too_large',
  'chat_fork_transfer_not_found',
  'chat_fork_transfer_offset_mismatch',
  'chat_fork_transfer_integrity_failed',
  'chat_fork_transfer_busy',
  'chat_fork_import_target_unsupported',
  'chat_fork_source_unavailable'
] as const

export type ChatForkTransferErrorCode = (typeof CHAT_FORK_TRANSFER_ERROR_CODES)[number]

export function chatForkTransferErrorCode(error: unknown): ChatForkTransferErrorCode | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return CHAT_FORK_TRANSFER_ERROR_CODES.find((code) => code === message) ?? null
}
