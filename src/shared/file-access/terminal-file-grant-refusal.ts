// Why: the host refuses a grant whose file changed, expired, or belongs to an earlier connection.
const RENEWABLE_TERMINAL_FILE_GRANT_REFUSALS: ReadonlySet<string> = new Set([
  'terminal_file_grant_stale',
  'terminal_file_grant_expired',
  'terminal_file_grant_mismatch'
])

/** A refusal a fresh grant for the same host path can answer. */
export function isRenewableTerminalFileGrantRefusal(message: string | undefined): boolean {
  return message !== undefined && RENEWABLE_TERMINAL_FILE_GRANT_REFUSALS.has(message)
}
