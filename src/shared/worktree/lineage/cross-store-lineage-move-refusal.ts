import type { PersistedState } from '../../persisted-state-types'
import { normalizeWorkspaceSessionKeyToWorkspaceId, parseWorkspaceKey } from '../../workspace-scope'
import { getWorktreePathBasenameFromId } from '../id'

type MoveSourceState = Pick<
  PersistedState,
  'crossStoreLineageByChildKey' | 'worktreeMeta' | 'folderWorkspaces'
>

/** Moves don't carry links to a parent on another machine; refuse before anything changes. */
export function assertNoCrossStoreLinkedWorkspaceInMove(
  state: MoveSourceState,
  inMove: (childKey: string) => boolean
): void {
  // Raw keys: an entry this build can't read still names a linked child.
  const linked = Object.keys(state.crossStoreLineageByChildKey ?? {}).find(inMove)
  if (linked !== undefined) {
    throw new Error(
      `"${workspaceName(state, linked)}" is nested under a workspace on another machine. Remove its parent, then move the project. Nothing was changed.`
    )
  }
}

function workspaceName(state: MoveSourceState, childKey: string): string {
  const scope = parseWorkspaceKey(childKey)
  if (scope?.type === 'folder') {
    const folder = state.folderWorkspaces.find((row) => row.id === scope.folderWorkspaceId)
    return folder?.name ?? scope.folderWorkspaceId
  }
  const worktreeId = normalizeWorkspaceSessionKeyToWorkspaceId(childKey)
  return (
    state.worktreeMeta[worktreeId]?.displayName ||
    getWorktreePathBasenameFromId(worktreeId) ||
    worktreeId
  )
}
