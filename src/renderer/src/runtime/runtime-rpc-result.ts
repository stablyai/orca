import type { RuntimeRpcFailure, RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'

// Why: the CLI reads the same flattened tokens, so the matcher lives in shared and both clients use one copy.
export { hasRuntimeRpcErrorCode } from '../../../shared/runtime-rpc-error-code'

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

// Why: mobile-scope device tokens are denied non-allowlisted runtime methods
// with code 'forbidden'. Callers use this to surface one scope-mismatch banner.
export function isRuntimeScopeForbiddenError(error: unknown): boolean {
  return error instanceof RuntimeRpcCallError && error.code === 'forbidden'
}

export function unwrapRuntimeRpcResult<TResult>(response: RuntimeRpcResponse<TResult>): TResult {
  if (response.ok === false) {
    throw new RuntimeRpcCallError(response)
  }
  return response.result
}
