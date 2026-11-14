import {
  floatingWorkspaceToWorktree,
  isFloatingWorkspaceId
} from '../../../../../shared/floating-workspace-worktree'
import { workspaceBrowserTabs } from '@/store/slices/browser/tabs/workspace-browser-tabs'
import { revealFloatingWorkspacePanel } from '@/components/floating-terminal/floating-workspace-panel-reveal'
import { useAppStore } from '@/store/index'
import {
  activateBrowserWorkspaceTab,
  getActivatableBrowserWorkspaceTab
} from '@/lib/browser/workspace/browser-workspace-tab-activation'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import { isBlankBrowserUrl } from './browser-palette-search'
import { activateAndRevealWorkspace } from '../../workspace/activation/worktree-activation'

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

/** Validate a palette page and activate its visible placement while retaining its backing host ownership. */
export function activateBrowserPagePaletteResult({
  executionHostId,
  pageId,
  workspaceId,
  worktreeId
}: BrowserPagePaletteActivationTarget): BrowserPagePaletteActivationResult {
  const initialState = useAppStore.getState()
  const floating = isFloatingWorkspaceId(worktreeId)
  const worktree =
    initialState.getKnownWorktreeById(worktreeId, executionHostId) ??
    (floating && (!executionHostId || executionHostId === 'local')
      ? floatingWorkspaceToWorktree('')
      : null)
  // Check workspace first: removal also purges pages and must not look like a merely stale page.
  if (!worktree) {
    return { status: 'failed', reason: 'missing-worktree' }
  }
  const workspaces = workspaceBrowserTabs(
    initialState.browserTabsByWorktree,
    worktreeId,
    initialState.unifiedTabsByWorktree[worktreeId]
  )
  const matches = workspaces.filter((candidate) => candidate.id === workspaceId)
  const workspace = matches.length === 1 ? matches[0] : undefined
  const page = (initialState.browserPagesByWorkspace[workspaceId] ?? []).find(
    (candidate) =>
      candidate.id === pageId &&
      candidate.workspaceId === workspaceId &&
      candidate.worktreeId === workspace?.worktreeId
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
  const activated =
    floating ||
    activateAndRevealWorkspace(worktree.id, targetHostId ? { executionHostId: targetHostId } : {})
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
  if (floating) {
    revealFloatingWorkspacePanel(useAppStore.getState())
  }
  return { status: 'activated', pageId, focusTarget }
}
