import type { BrowserTabSplitDirection } from './browser-tab-split-direction'

// Payload of main's `browser:requestTabCreate` IPC to the renderer that owns the window.
export type BrowserTabCreateRequest = {
  requestId: string
  url: string
  worktreeId?: string
  browserPageId?: string
  sessionProfileId?: string | null
  sessionPartition?: string
  activate?: boolean
  fallbackWorktreeId?: string
  split?: BrowserTabSplitDirection
  splitFromTabId?: string
}
