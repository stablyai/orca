import type { Tab } from '../../../shared/tab-types'
import type { AppState } from '../store/types'

export type BrowserWorkspaceOwner = {
  worktreeId: string
  workspaceId: string
}

export function resolveBrowserWorkspaceOwner(
  state: Pick<AppState, 'browserTabsByWorktree' | 'browserPagesByWorkspace'>,
  sourceId: string,
  requiredWorktreeId?: string
): BrowserWorkspaceOwner | null {
  for (const [worktreeId, workspaces] of Object.entries(state.browserTabsByWorktree)) {
    if (requiredWorktreeId && worktreeId !== requiredWorktreeId) {
      continue
    }
    for (const workspace of workspaces) {
      if (
        workspace.id === sourceId ||
        (state.browserPagesByWorkspace[workspace.id] ?? []).some((page) => page.id === sourceId)
      ) {
        return { worktreeId, workspaceId: workspace.id }
      }
    }
  }
  return null
}

/**
 * The unified tab wrapping a source browser page. Anything but exactly one live wrapper in the
 * caller's workspace is ambiguous, so the caller omits the source relationship.
 */
export function resolveBrowserSourceUnifiedTab(
  state: Pick<
    AppState,
    | 'browserTabsByWorktree'
    | 'browserPagesByWorkspace'
    | 'unifiedTabsByWorktree'
    | 'groupsByWorktree'
  >,
  sourcePageId: string,
  worktreeId: string
): Tab | undefined {
  const owningWorkspaceIds = (state.browserTabsByWorktree[worktreeId] ?? [])
    .filter((workspace) =>
      (state.browserPagesByWorkspace[workspace.id] ?? []).some((page) => page.id === sourcePageId)
    )
    .map((workspace) => workspace.id)
  if (owningWorkspaceIds.length !== 1) {
    return undefined
  }
  const wrappers = (state.unifiedTabsByWorktree[worktreeId] ?? []).filter(
    (tab) => tab.contentType === 'browser' && tab.entityId === owningWorkspaceIds[0]
  )
  if (wrappers.length !== 1) {
    return undefined
  }
  const wrapper = wrappers[0]
  const group = (state.groupsByWorktree[worktreeId] ?? []).find(
    (candidate) => candidate.id === wrapper.groupId
  )
  return group?.tabOrder.includes(wrapper.id) ? wrapper : undefined
}
