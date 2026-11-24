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

const GENERIC_RUNTIME_ERROR_CODE = 'runtime_error'

function structuredErrorCodes(error: unknown): string[] {
  const codes: string[] = []
  const seen = new Set<unknown>()
  let current = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const nested: unknown = Reflect.get(current, 'error')
    const response: unknown = Reflect.get(current, 'response')
    const responseError: unknown =
      response && typeof response === 'object' ? Reflect.get(response, 'error') : undefined
    for (const holder of [current, nested, responseError]) {
      const code: unknown =
        holder && typeof holder === 'object' ? Reflect.get(holder, 'code') : undefined
      if (typeof code === 'string') {
        codes.push(code)
      }
    }
    current = Reflect.get(current, 'cause')
  }
  return codes
}

/**
 * The failure's code from `known` only, for diagnostics that must not log messages: a host can put
 * any text in `code`, so other codes read as `other_code`. A specific code beats the generic
 * runtime_error wrapper, including one older hosts flatten into its message.
 */
export function readRuntimeRpcErrorCode(error: unknown, known: readonly string[]): string | null {
  const structured = structuredErrorCodes(error)
  const specific =
    structured.find((code) => code !== GENERIC_RUNTIME_ERROR_CODE && known.includes(code)) ??
    known.find((code) => code !== GENERIC_RUNTIME_ERROR_CODE && hasRuntimeRpcErrorCode(error, code))
  if (specific) {
    return specific
  }
  if (
    structured.includes(GENERIC_RUNTIME_ERROR_CODE) &&
    known.includes(GENERIC_RUNTIME_ERROR_CODE)
  ) {
    return GENERIC_RUNTIME_ERROR_CODE
  }
  return structured.length > 0 ? 'other_code' : null
}
