import type {
  RuntimeRpcFailure,
  RuntimeRpcResponse
} from '../../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

// Why: the CLI reads the same flattened tokens, so the matcher lives in shared and both clients use one copy.

/** A local identity guard rejected the request before dispatch, not a lost reply. */
export class RuntimeConnectionChangedBeforeSendError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RuntimeConnectionChangedBeforeSendError'
  }
}

export class RuntimeRpcCallError extends Error {
  readonly code: string
  readonly response: RuntimeRpcFailure
  /** The runtime that refused, when the caller knows it: its words call it "this computer". */
  readonly target?: RuntimeClientTarget

  constructor(response: RuntimeRpcFailure, target?: RuntimeClientTarget) {
    super(response.error.message)
    this.name = 'RuntimeRpcCallError'
    this.code = response.error.code
    this.response = response
    this.target = target
  }
}

export function unwrapRuntimeRpcResult<TResult>(response: RuntimeRpcResponse<TResult>): TResult {
  if (response.ok === false) {
    throw new RuntimeRpcCallError(response)
  }
  return response.result
}

// Mobile tokens refuse nonallowlisted methods as forbidden; surface one scope banner instead of empty/retrying UI.
export function isRuntimeScopeForbiddenError(error: unknown): boolean {
  return error instanceof RuntimeRpcCallError && error.code === 'forbidden'
}
