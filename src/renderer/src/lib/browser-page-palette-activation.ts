import { useAppStore } from '@/store'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { isBlankBrowserUrl } from './browser-palette-search'
import { activateAndRevealWorktree } from './worktree-activation'

export type BrowserPagePaletteActivationFailure =
  | 'missing-page'
  | 'missing-tab'
  | 'missing-worktree'

export type BrowserPageFocusTarget = 'address-bar' | 'webview'

export type BrowserPagePaletteActivationResult =
  | { status: 'activated'; pageId: string; focusTarget: BrowserPageFocusTarget }
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
  const page = (initialState.browserPagesByWorkspace[workspaceId] ?? []).find(
    (candidate) => candidate.id === pageId
  )
  const workspace = (initialState.browserTabsByWorktree[worktreeId] ?? []).find(
    (candidate) => candidate.id === workspaceId
  )
  const worktree = initialState.getKnownWorktreeById(worktreeId, executionHostId)
  // Why worktree first: removing a worktree also purges its browser workspaces
  // and pages, so a page-first check would report a dead workspace as a stale page.
  if (!worktree) {
    return { status: 'failed', reason: 'missing-worktree' }
  }
  if (!page || !workspace) {
    return { status: 'failed', reason: 'missing-page' }
  }

  // Why: activateAndRevealWorktree mutates store state, so a later page lookup
  // is unreliable — resolve the focus target from the URL captured here.
  const focusTarget: BrowserPageFocusTarget = isBlankBrowserUrl(page.url)
    ? 'address-bar'
    : 'webview'

  const targetHostId = executionHostId ?? worktree.hostId
  const activated = activateAndRevealWorktree(
    worktree.id,
    targetHostId ? { executionHostId: targetHostId } : {}
  )
  if (!activated) {
    return { status: 'failed', reason: 'missing-worktree' }
  }

  const state = useAppStore.getState()
  const matchingUnifiedTab = (state.unifiedTabsByWorktree[worktree.id] ?? []).find(
    (candidate) => candidate.contentType === 'browser' && candidate.entityId === workspace.id
  )
  // Why: the pane renders whatever the group's active tab is, so without a unified
  // tab the browser state would go active behind a tab that never shows the page.
  if (!matchingUnifiedTab) {
    return { status: 'failed', reason: 'missing-tab' }
  }
  state.focusGroup(worktree.id, matchingUnifiedTab.groupId)
  state.activateTab(matchingUnifiedTab.id)
  state.setActiveBrowserTab(workspace.id)
  state.setActiveBrowserPage(workspace.id, pageId)
  return { status: 'activated', pageId, focusTarget }
}
