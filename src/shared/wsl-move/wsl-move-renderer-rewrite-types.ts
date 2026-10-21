/** The renderer's half of a committed WSL move's desktop rewrite, as carried over IPC. */

export type WslMovePendingRendererRewrite = {
  migrationId: string
  /** Renderer-side stores still to rewrite, in order. */
  storeIds: string[]
  destinationEnvironmentId: string
  destinationHostId: `runtime:${string}`
  distro: string
  scopeRepoIds: string[]
  scopeFolderWorkspaceIds: string[]
}

export type WslMoveRecordStoreRewrittenRequest = {
  migrationId: string
  storeId: string
}

export type WslMoveRecordStoreRewrittenResult =
  | { recorded: true }
  | {
      recorded: false
      reason: 'gated-off' | 'unknown-store' | 'not-renderer-store' | 'not-pending' | 'failed'
    }
