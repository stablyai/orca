import { useAppStore } from '@/store'
import {
  activateBrowserWorkspaceTab,
  getActivatableBrowserWorkspaceTab
} from '@/lib/browser-workspace-tab-activation'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { isBlankBrowserUrl } from './browser-palette-search'
import { activateAndRevealWorkspace } from './worktree-activation'

export type BrowserPagePaletteActivationFailure =
  | 'missing-page'
  | 'missing-tab'
  | 'missing-worktree'

export type BrowserPageFocusTarget = 'address-bar' | 'webview'

export type BrowserPagePaletteActivationResult =
  | { status: 'activated'; pageId: string; focusTarget: BrowserPageFocusTarget }
  | { status: 'blocked' }
  | { status: 'failed'; reason: BrowserPagePaletteActivationFailure }

export type BrowserPagePaletteActivationTarget = {
  executionHostId?: ExecutionHostId
  pageId: string
  workspaceId: string
  worktreeId: string
}

export function activateBrowserPagePaletteResult({
  executionHostId,
  pageId,
  workspaceId,
  worktreeId
}: BrowserPagePaletteActivationTarget): BrowserPagePaletteActivationResult {
  const initialState = useAppStore.getState()
  const worktree = initialState.getKnownWorktreeById(worktreeId, executionHostId)
  // Check workspace first: removal also purges pages and must not look like a merely stale page.
  if (!worktree) {
    return { status: 'failed', reason: 'missing-worktree' }
  }
  const page = (initialState.browserPagesByWorkspace[workspaceId] ?? []).find(
    (candidate) =>
      candidate.id === pageId &&
      candidate.workspaceId === workspaceId &&
      candidate.worktreeId === worktreeId
  )
  const workspace = (initialState.browserTabsByWorktree[worktreeId] ?? []).find(
    (candidate) => candidate.id === workspaceId && candidate.worktreeId === worktreeId
  )
  if (!page || !workspace) {
    return { status: 'failed', reason: 'missing-page' }
  }

  // Capture the URL before activateAndRevealWorkspace mutates the page state.
  const focusTarget: BrowserPageFocusTarget = isBlankBrowserUrl(page.url)
    ? 'address-bar'
    : 'webview'

  const targetHostId = executionHostId ?? worktree.hostId
  if (
    !getActivatableBrowserWorkspaceTab({ worktreeId, workspaceId, executionHostId: targetHostId })
  ) {
    return { status: 'failed', reason: 'missing-tab' }
  }
  const activated = activateAndRevealWorkspace(
    worktree.id,
    targetHostId ? { executionHostId: targetHostId } : {}
  )
  if (!activated) {
    return { status: 'blocked' }
  }

  // Without a unified tab, browser activation would stay hidden behind the current tab.
  if (
    !activateBrowserWorkspaceTab({
      worktreeId: worktree.id,
      workspaceId: workspace.id,
      pageId,
      ...(targetHostId ? { executionHostId: targetHostId } : {})
    })
  ) {
    return { status: 'failed', reason: 'missing-tab' }
  }
  return { status: 'activated', pageId, focusTarget }
}
