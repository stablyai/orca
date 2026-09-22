// Why: the local RPC socket answers over-limit connections with this failure instead of
// closing them unread, which clients could not tell apart from a dead runtime.
export const RUNTIME_RPC_CONNECTION_LIMIT_ERROR_CODE = 'runtime_busy'

export const RUNTIME_RPC_CONNECTION_LIMIT_MESSAGE =
  'Orca is busy (connection limit); retry shortly.'

export type RuntimeRpcConnectionLimitData = {
  retryable: true
  reason: 'connection_limit'
  // Why: long-poll admission also answers runtime_busy; only this flag proves a resend cannot double-apply.
  dispatched: false
  nextSteps: string[]
}

export function buildRuntimeRpcConnectionLimitFailure(id: string): {
  id: string
  ok: false
  error: { code: string; message: string; data: RuntimeRpcConnectionLimitData }
} {
  return {
    id,
    ok: false,
    error: {
      code: RUNTIME_RPC_CONNECTION_LIMIT_ERROR_CODE,
      message: RUNTIME_RPC_CONNECTION_LIMIT_MESSAGE,
      data: {
        retryable: true,
        reason: 'connection_limit',
        dispatched: false,
        nextSteps: ['Retry the command in a few seconds.']
      }
    }
  }
}

export function isUndispatchedRuntimeBusyFailure(error: { code: string; data?: unknown }): boolean {
  return (
    error.code === RUNTIME_RPC_CONNECTION_LIMIT_ERROR_CODE &&
    typeof error.data === 'object' &&
    error.data !== null &&
    'dispatched' in error.data &&
    error.data.dispatched === false
  )
}
