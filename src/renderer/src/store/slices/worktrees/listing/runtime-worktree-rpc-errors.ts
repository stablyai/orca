import { hasRuntimeRpcErrorCode, RuntimeRpcCallError } from '../../../../runtime/runtime-rpc-client'
import { translate } from '@/i18n/i18n'

export function worktreeMetadataUnavailableResult(): { ok: false; error: string } {
  return {
    ok: false,
    error: translate(
      'auto.store.slices.worktrees.c6cf133786',
      'This workspace is no longer available.'
    )
  }
}

export function isRuntimeMethodNotFoundError(error: unknown): boolean {
  return error instanceof RuntimeRpcCallError && error.code === 'method_not_found'
}

export function isRuntimeSelectorNotFoundError(error: unknown): boolean {
  return hasRuntimeRpcErrorCode(error, 'selector_not_found')
}

export function isRuntimeRepoNotFoundError(error: unknown): boolean {
  return hasRuntimeRpcErrorCode(error, 'repo_not_found')
}

/** Thrown before the worktree exists, so the caller can safely retry without the parent.
 *  Matches re-wrapped errors too: relay and environment transports lose the RuntimeRpcCallError. */
export function isRuntimeLineageParentMissingError(error: unknown): boolean {
  return hasRuntimeRpcErrorCode(error, 'LINEAGE_PARENT_NOT_FOUND')
}
