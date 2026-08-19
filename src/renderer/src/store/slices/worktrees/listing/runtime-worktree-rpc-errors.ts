import { hasRuntimeRpcErrorCode, RuntimeRpcCallError } from '../../../../runtime/runtime-rpc-client'

export function isRuntimeMethodNotFoundError(error: unknown): boolean {
  return error instanceof RuntimeRpcCallError && error.code === 'method_not_found'
}

export function isRuntimeSelectorNotFoundError(error: unknown): boolean {
  return hasRuntimeRpcErrorCode(error, 'selector_not_found')
}

export function isRuntimeRepoNotFoundError(error: unknown): boolean {
  return hasRuntimeRpcErrorCode(error, 'repo_not_found')
}
