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
  return (state.browserTabsByWorktree[worktreeId] ?? []).some((workspace) => {
    const hasRemotePage = (state.browserPagesByWorkspace[workspace.id] ?? []).some((page) => {
      const handle = state.remoteBrowserPageHandlesByPageId[page.id]
      // Why: a staged handle is this client's own optimistic guess, not proof the host published
      // the page — treating it as materialized would let the create path confirm itself.
      return (
        handle?.environmentId === environmentId &&
        handle.remotePageId === remotePageId &&
        handle.staged !== true
      )
    })
    if (!hasRemotePage) {
      return false
    }
    return (state.unifiedTabsByWorktree[worktreeId] ?? []).some(
      (tab) =>
        tab.contentType === 'browser' &&
        tab.entityId === workspace.id &&
        (!expectedGroupId || tab.groupId === expectedGroupId)
    )
  })
}
