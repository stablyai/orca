// Wire validation does not require _meta, and shell-produced native replies have no runtime to name.
export type RpcSuccess = {
  id: string
  ok: true
  result: unknown
  streaming?: true
  _meta?: { runtimeId: string }
}

export type RpcFailure = {
  id: string
  ok: false
  error: { code: string; message: string; data?: unknown }
  _meta?: { runtimeId: string }
}

export type RpcResponse = RpcSuccess | RpcFailure

export function isRpcResponse(value: unknown): value is RpcResponse {
  if (!value || typeof value !== 'object') {
    return false
  }
  const response = value as {
    id?: unknown
    ok?: unknown
    error?: { code?: unknown; message?: unknown }
  }
  if (typeof response.id !== 'string') {
    return false
  }
  if (response.ok === true) {
    return Object.hasOwn(response, 'result')
  }
  return (
    response.ok === false &&
    !!response.error &&
    typeof response.error.code === 'string' &&
    typeof response.error.message === 'string'
  )
}
