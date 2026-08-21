import type { RuntimeRpcFailure, RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'

export class RuntimeRpcCallError extends Error {
  readonly code: string
  readonly response: RuntimeRpcFailure

  constructor(response: RuntimeRpcFailure) {
    super(response.error.message)
    this.name = 'RuntimeRpcCallError'
    this.code = response.error.code
    this.response = response
  }
}

// Why: transports re-wrap the token into a longer message and drop the cause (Electron IPC's
// "Error invoking remote method 'x': Error: selector_not_found", relay envelope re-throws), so the
// token classifies only as the whole message or after a real message boundary (": " or a newline) —
// prose that merely trails off in the token must not reach the destructive forget-local fallback.
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
      response?: { error?: { code?: unknown; message?: unknown } }
    }
    // Machine tokens are checked before messages so a subclass with a human-readable message still classifies by code.
    if (candidate.code === expectedCode || candidate.response?.error?.code === expectedCode) {
      return true
    }
    const messages = [candidate.message, candidate.response?.error?.message]
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

export function unwrapRuntimeRpcResult<TResult>(response: RuntimeRpcResponse<TResult>): TResult {
  if (response.ok === false) {
    throw new RuntimeRpcCallError(response)
  }
  return response.result
}
