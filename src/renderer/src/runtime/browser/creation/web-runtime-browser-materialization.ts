import type { AppState } from '@/store/types'

type BrowserMaterializationState = Pick<
  AppState,
  | 'browserPagesByWorkspace'
  | 'browserTabsByWorktree'
  | 'remoteBrowserPageHandlesByPageId'
  | 'unifiedTabsByWorktree'
>

/** Check whether the host page has a client browser view, including views placed outside the source workspace. */
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
      // Staged handles are optimistic guesses, not proof the host published the page.
      return (
        handle?.environmentId === environmentId &&
        handle.remotePageId === remotePageId &&
        handle.staged !== true
      )
    })
    if (!hasRemotePage) {
      return false
    }
    return Object.values(state.unifiedTabsByWorktree)
      .flat()
      .some(
        (tab) =>
          tab.contentType === 'browser' &&
          tab.entityId === workspace.id &&
          (!expectedGroupId || tab.groupId === expectedGroupId)
      )
  })
}
