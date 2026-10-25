/** Read machine tokens across IPC wrappers and older hosts that flatten class errors to runtime_error messages.
 * Matching only code misses those failures. */

// Match whole messages or real message boundaries (: or newline); trailing prose alone must not classify as a token.
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
