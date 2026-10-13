import { useAppStore } from '@/store'
import { isUnifiedTabPinned } from '@/store/pinned-tab-close-guard'
import { resolveBrowserSourceUnifiedTab } from './browser-workspace-source-resolution'
import { closeWorkspaceBrowserTab } from './workspace-browser-tab-close'
import { getRuntimeEnvironmentIdForWorktree } from './worktree-runtime-owner'

/** A page asked to close itself with window.close(): close it the way its tab's close button does. */
export function closeBrowserPageFromGuest(pageId: string): void {
  const state = useAppStore.getState()
  const page = Object.values(state.browserPagesByWorkspace)
    .flat()
    .find((candidate) => candidate.id === pageId)
  if (!page || getRuntimeEnvironmentIdForWorktree(state, page.worktreeId)) {
    return
  }
  if ((state.browserPagesByWorkspace[page.workspaceId] ?? []).length > 1) {
    state.closeBrowserPage(pageId)
    return
  }
  // Why: a pin is the user's promise to keep the tab, and a page must not raise its confirm dialog.
  if (isUnifiedTabPinned(state, page.worktreeId, page.workspaceId)) {
    return
  }
  const unifiedTab = resolveBrowserSourceUnifiedTab(state, pageId, page.worktreeId)
  closeWorkspaceBrowserTab(page.worktreeId, page.workspaceId, unifiedTab?.id)
}
