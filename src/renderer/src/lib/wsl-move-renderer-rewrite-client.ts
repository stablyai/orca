/**
 * The renderer's side of a committed WSL move's desktop rewrite: which renderer stores a move still
 * needs, and recording one once it is rewritten and persisted. Main refuses both with the gate off.
 */
import type {
  WslMovePendingRendererRewrite,
  WslMoveRecordStoreRewrittenResult
} from '../../../shared/wsl-move/wsl-move-renderer-rewrite-types'

export function listPendingWslMoveRendererRewrites(): Promise<WslMovePendingRendererRewrite[]> {
  return window.api.wslMove.listPendingRendererRewrites()
}

/** Only after the store's rewrite is durable: the ledger entry means it never runs again. */
export function recordWslMoveRendererStoreRewritten(
  migrationId: string,
  storeId: string
): Promise<WslMoveRecordStoreRewrittenResult> {
  return window.api.wslMove.recordStoreRewritten({ migrationId, storeId })
}
