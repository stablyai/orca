import { findBrowserWorkspaceForRemotePage } from './web-session-tabs-sync/mirrored-browser-tabs'
import type { AppState } from '@/store/types'

type BrowserMaterializationState = Pick<
  AppState,
  | 'browserPagesByWorkspace'
  | 'browserTabsByWorktree'
  | 'remoteBrowserPageHandlesByPageId'
  | 'unifiedTabsByWorktree'
>

export function hasMaterializedWebRuntimeBrowserPage(
  state: BrowserMaterializationState,
  environmentId: string,
  worktreeId: string,
  remotePageId: string,
  expectedGroupId?: string
): boolean {
  const found = findBrowserWorkspaceForRemotePage(state, worktreeId, environmentId, remotePageId)
  return Boolean(
    found?.unifiedTab &&
    state.remoteBrowserPageHandlesByPageId[found.page.id]?.staged !== true &&
    (!expectedGroupId || found.unifiedTab.groupId === expectedGroupId)
  )
}
