/** The renderer's half of a committed WSL move's desktop rewrite, as carried over IPC. */
import type { WslMappedDrive } from './wsl-mapped-drive-paths'

/** The renderer-side stores, in run order; main registers each so the ledger waits on it. */
export const WSL_MOVE_RENDERER_REWRITE_STORE_IDS = [
  'quick-open-history',
  'file-view-preferences',
  'notebook-environments'
] as const

export type WslMoveRendererRewriteStoreId = (typeof WSL_MOVE_RENDERER_REWRITE_STORE_IDS)[number]

/**
 * A committed move, from `destination-committed` on. Renderer storage flushes lazily, so the
 * renderer re-applies its stores for every listed move; only `storeIds` still need a ledger entry.
 */
export type WslMovePendingRendererRewrite = {
  migrationId: string
  /** Renderer-side stores still to record, in order; empty once the move left its rewrite phase. */
  storeIds: string[]
  destinationEnvironmentId: string
  destinationHostId: `runtime:${string}`
  distro: string
  scopeRepoIds: string[]
  scopeFolderWorkspaceIds: string[]
  /** The moved projects' directories on the host, for stores keyed by a bare file path. */
  scopeRootPaths: string[]
  /** The move's mapped drives, from its journal: `W:\x` paths and `w:/x` keys moved too. */
  mappedDrives?: WslMappedDrive[]
}

export type WslMoveRecordStoreRewrittenRequest = {
  migrationId: string
  storeId: string
}

export type WslMoveRecordStoreRewrittenResult =
  | { recorded: true }
  | {
      recorded: false
      reason:
        | 'gated-off'
        | 'unknown-store'
        | 'not-renderer-store'
        | 'not-pending'
        | 'not-main-window'
        | 'failed'
    }
