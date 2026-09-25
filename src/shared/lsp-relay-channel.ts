// Shared vocabulary for the relay `lsp.*` channel (ticket 17). Both the relay
// handler (src/relay/lsp-handler.ts) and the main-process SSH adapter
// (src/main/language-servers/ssh-language-server-adapter.ts) import these so the
// wire surface — method names, the JSON-RPC method-not-found code a new client
// probes for capability, and the notification methods an old client must drop —
// lives in one place. See docs/reference/remote-wire-compatibility.md: a NEW
// request method is capability-negotiated by probing it; an old relay answers
// `-32601` (method_not_found) so the absence is visible and the client degrades.

/** JSON-RPC method-not-found error code (RFC 9512 / the relay dispatcher's raw literal). */
export const JSON_RPC_METHOD_NOT_FOUND_CODE = -32601

export const LSP_RELAY_METHODS = {
  spawn: 'lsp.spawn',
  write: 'lsp.write',
  kill: 'lsp.kill',
  ack: 'lsp.ack',
  data: 'lsp.data',
  stderr: 'lsp.stderr',
  exit: 'lsp.exit'
} as const

/**
 * True when an error from an `lsp.*` request is the relay's method-not-found
 * answer — the signal that an incumbent relay predates ticket 17 and the whole
 * `lsp.*` family is absent. A new client probes `lsp.spawn` once per target and,
 * on this answer, marks SSH LSP unavailable (graceful degradation) rather than
 * retrying every navigation request.
 *
 * The code is read as both a number (relay dispatcher) and the string
 * `'method_not_found'` (the SSH mux's `isMethodNotFoundError` path), so a future
 * transport that stringifies the code still degrades.
 */
export function isLspMethodNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  const code = (error as { code?: unknown }).code
  return code === JSON_RPC_METHOD_NOT_FOUND_CODE || code === 'method_not_found'
}
