const PHYSICAL_EXIT_PROOF_TIMEOUT_MS = 8_000
const PROVIDER_DELIVERY_MARGIN_MS = 2_000
const WINDOWS_DESTRUCTIVE_PREFIX_TIMEOUT_MS = 3_000 + 5_000
const COLD_DAEMON_RECONNECT_TIMEOUT_MS = 5_000
const SSH_MUX_SHUTDOWN_TIMEOUT_MS = 30_000
const SSH_FINAL_PROOF_MARGIN_MS = 5_000

const POSIX_PROVIDER_WORST_CASE_MS = PHYSICAL_EXIT_PROOF_TIMEOUT_MS + PROVIDER_DELIVERY_MARGIN_MS
const WINDOWS_PROVIDER_WORST_CASE_MS =
  WINDOWS_DESTRUCTIVE_PREFIX_TIMEOUT_MS +
  PHYSICAL_EXIT_PROOF_TIMEOUT_MS +
  PROVIDER_DELIVERY_MARGIN_MS
const COLD_DAEMON_PROVIDER_WORST_CASE_MS =
  COLD_DAEMON_RECONNECT_TIMEOUT_MS + PHYSICAL_EXIT_PROOF_TIMEOUT_MS + PROVIDER_DELIVERY_MARGIN_MS
const SSH_PROVIDER_WORST_CASE_MS = SSH_MUX_SHUTDOWN_TIMEOUT_MS + SSH_FINAL_PROOF_MARGIN_MS

// Why: routing cannot prove the provider class before teardown, so every durable close reserves the worst supported path.
export const TERMINAL_TAB_PROVIDER_TEARDOWN_TIMEOUT_MS = Math.max(
  POSIX_PROVIDER_WORST_CASE_MS,
  WINDOWS_PROVIDER_WORST_CASE_MS,
  COLD_DAEMON_PROVIDER_WORST_CASE_MS,
  SSH_PROVIDER_WORST_CASE_MS
)
export const TERMINAL_TAB_PROVIDER_RPC_TIMEOUT_MS =
  TERMINAL_TAB_PROVIDER_TEARDOWN_TIMEOUT_MS + 2_000
export const TERMINAL_TAB_CLOSE_RESPONSE_TIMEOUT_MS = TERMINAL_TAB_PROVIDER_RPC_TIMEOUT_MS + 2_000
export const TERMINAL_TAB_CLOSE_CALLER_TIMEOUT_MS = TERMINAL_TAB_CLOSE_RESPONSE_TIMEOUT_MS + 1_000
export const TERMINAL_TAB_CLOSE_ACK_MARGIN_MS =
  TERMINAL_TAB_CLOSE_CALLER_TIMEOUT_MS - TERMINAL_TAB_CLOSE_RESPONSE_TIMEOUT_MS

export function resolveNestedTerminalTabCloseTimeoutMs(deadlineMs: number): number {
  return Math.max(1, deadlineMs - Date.now() - TERMINAL_TAB_CLOSE_ACK_MARGIN_MS)
}

export function resolveTerminalTabProviderTimeoutMs(
  deadlineMs: number,
  maximumMs = TERMINAL_TAB_PROVIDER_TEARDOWN_TIMEOUT_MS
): number {
  return Math.max(
    1,
    Math.min(maximumMs, deadlineMs - Date.now() - TERMINAL_TAB_CLOSE_ACK_MARGIN_MS)
  )
}

const TERMINAL_TAB_CLOSE_RPC_METHODS = new Set([
  'session.tabs.close',
  'session.tabs.closeLifecycle',
  'terminal.closeTab'
])

export function isTerminalTabCloseRpcMethod(method: string): boolean {
  return TERMINAL_TAB_CLOSE_RPC_METHODS.has(method)
}

export function resolveTerminalTabCloseCallerTimeoutMs(
  method: string,
  requestedTimeoutMs: number
): number {
  return isTerminalTabCloseRpcMethod(method)
    ? Math.max(requestedTimeoutMs, TERMINAL_TAB_CLOSE_CALLER_TIMEOUT_MS)
    : requestedTimeoutMs
}

export type TerminalTabCloseRequest = {
  requestId: string
  tabId: string
  deadlineMs: number
}

export type TerminalTabCloseResponse = {
  requestId: string
  error?: string
}
