/**
 * Classifies a runtime RPC failure by its machine token.
 *
 * Shared rather than renderer-owned because every client reads the same
 * flattened shapes: Electron IPC rewraps the message ("Error invoking remote
 * method 'x': Error: …") and a host that does not know an error class maps it
 * to `runtime_error` with the token left on the message. A client that matches
 * only `.code` therefore classifies a subset of what it receives.
 */

// Why: transports re-wrap the token into a longer message and drop the cause, so the
// token classifies only as the whole message or after a real message boundary (": " or a
// newline) — prose that merely trails off in the token must not classify.
const CODE_TOKEN_BOUNDARY = /(?:: |\n)[ \t]*$/

function endsWithCodeToken(text: string, expectedCode: string): boolean {
  const trimmed = text.trimEnd()
  if (!trimmed.endsWith(expectedCode)) {
    return false
  }
  const prefix = trimmed.slice(0, -expectedCode.length)
  return prefix.trim() === '' || CODE_TOKEN_BOUNDARY.test(prefix)
}

export function hasRuntimeRpcErrorCode(error: unknown, expectedCode: string): boolean {
  const seen = new Set<unknown>()
  let current = error
  while (!seen.has(current)) {
    if (typeof current === 'string') {
      return endsWithCodeToken(current, expectedCode)
    }
    if (!current || typeof current !== 'object') {
      return false
    }
    seen.add(current)
    const candidate = current as {
      cause?: unknown
      code?: unknown
      message?: unknown
      error?: { code?: unknown; message?: unknown }
      response?: { error?: { code?: unknown; message?: unknown } }
    }
    // Machine tokens are checked before messages so a subclass with a human-readable message still classifies by code.
    if (
      candidate.code === expectedCode ||
      candidate.error?.code === expectedCode ||
      candidate.response?.error?.code === expectedCode
    ) {
      return true
    }
    const messages = [
      candidate.message,
      candidate.error?.message,
      candidate.response?.error?.message
    ]
    if (
      messages.some(
        (message) => typeof message === 'string' && endsWithCodeToken(message, expectedCode)
      )
    ) {
      return true
    }
    current = candidate.cause
  }
  return false
}
