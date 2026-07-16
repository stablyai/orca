export type RuntimeUserCloseSource =
  | 'user-tab-close'
  | 'user-pane-close'
  | 'user-bulk-close'
  | 'cli'
  | 'automation'

export type RuntimeCloseIntentSource =
  | RuntimeUserCloseSource
  | 'client-created-rollback'
  | 'lifecycle-cleanup'
  | 'pty-exit-echo'
  | 'mirror-detached'

export type RuntimeCloseIntent = {
  source: RuntimeCloseIntentSource
  userInitiated: boolean
  requestId: string
  occurredAt: number
  worktreeId: string
  clientTabId?: string
  hostTabId?: string
  ptyOrHandle?: string
}
