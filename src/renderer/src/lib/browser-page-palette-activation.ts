import { useAppStore } from '@/store'
import { isBlankBrowserUrl } from './browser-palette-search'
import { activateAndRevealWorktree } from './worktree-activation'

export type BrowserPagePaletteActivationFailure = 'missing-page' | 'missing-worktree'

export type BrowserPageFocusTarget = 'address-bar' | 'webview'

export type BrowserPagePaletteActivationResult =
  | { status: 'activated'; pageId: string; focusTarget: BrowserPageFocusTarget }
  | { status: 'failed'; reason: BrowserPagePaletteActivationFailure }

export type BrowserPagePaletteActivationTarget = {
  pageId: string
  workspaceId: string
  worktreeId: string
}

export function activateBrowserPagePaletteResult({
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
  const worktree = initialState.getKnownWorktreeById(worktreeId)
  if (!page || !workspace || !worktree) {
    return { status: 'failed', reason: 'missing-page' }
  }

  // Why: activateAndRevealWorktree mutates store state, so a later page lookup
  // is unreliable — resolve the focus target from the URL captured here.
  const focusTarget: BrowserPageFocusTarget = isBlankBrowserUrl(page.url)
    ? 'address-bar'
    : 'webview'

  const activated = activateAndRevealWorktree(
    worktree.id,
    worktree.hostId ? { executionHostId: worktree.hostId } : {}
  )
  if (!activated) {
    return { status: 'failed', reason: 'missing-worktree' }
  }

  const state = useAppStore.getState()
  state.setActiveBrowserTab(workspace.id)
  state.setActiveBrowserPage(workspace.id, pageId)
  return { status: 'activated', pageId, focusTarget }
}
