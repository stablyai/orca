import type { AppState } from '@/store/types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { getExecutionHostIdFromWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import {
  normalizeWorkspaceSessionKeyToWorkspaceId,
  parseWorkspaceKey
} from '../../../shared/workspace-scope'
import {
  getWorktreeIdFromVisitKey,
  getWorktreeVisitTimestamp,
  isHostQualifiedVisitKey
} from './worktree-visit-recency'

type WorkspaceSelectionState = Pick<
  AppState,
  | 'lastVisitedAtByWorktreeId'
  | 'getKnownWorktreeById'
  | 'setActiveView'
  | 'setActiveRepo'
  | 'setActiveWorktree'
  | 'setActiveFolderWorkspace'
>

export function restoreActiveServerWorkspace(
  state: WorkspaceSelectionState,
  hostId: ExecutionHostId
): void {
  let latest = 0
  let selected: ReturnType<WorkspaceSelectionState['getKnownWorktreeById']>
  for (const key of Object.keys(state.lastVisitedAtByWorktreeId)) {
    if (
      isHostQualifiedVisitKey(key) &&
      getExecutionHostIdFromWorktreeHostIdentity(key) !== hostId
    ) {
      continue
    }
    const id = normalizeWorkspaceSessionKeyToWorkspaceId(getWorktreeIdFromVisitKey(key))
    const workspace = state.getKnownWorktreeById(id, hostId)
    if (!workspace || workspace.isArchived) {
      continue
    }
    const visitedAt =
      getWorktreeVisitTimestamp(state.lastVisitedAtByWorktreeId, { id, hostId }) ?? 0
    if (visitedAt > latest) {
      latest = visitedAt
      selected = workspace
    }
  }

  state.setActiveView('terminal')
  const scope = selected ? parseWorkspaceKey(selected.id) : null
  if (scope?.type === 'folder') {
    state.setActiveFolderWorkspace(scope.folderWorkspaceId, hostId)
  } else {
    state.setActiveRepo(selected?.repoId ?? null)
    state.setActiveWorktree(selected?.id ?? null, selected ? hostId : undefined)
  }
}
