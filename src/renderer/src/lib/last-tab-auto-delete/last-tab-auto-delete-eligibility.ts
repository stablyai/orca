import type { AppState } from '@/store'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  readLastTabAutoDeleteMode,
  type LastTabAutoDeleteMode
} from '../../../../shared/worktree-deletion-preferences'
import type { Worktree } from '../../../../shared/worktree/types'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import { getFolderWorkspaceHostId } from '../../../../shared/folder-workspace-execution-host'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { getWorktreeOnHostFromState } from '@/store/selectors'
import { selectFolderWorkspaces } from '@/store/workspace-record-selectors'
import type { LastTabAutoDeleteCandidate } from './last-tab-auto-delete-candidate'

export type LastTabAutoDeleteTarget =
  | { kind: 'worktree'; worktree: Worktree }
  | { kind: 'folder'; folderWorkspaceId: string; executionHostId?: ExecutionHostId }

function modeCoversCandidate(
  mode: LastTabAutoDeleteMode,
  candidate: LastTabAutoDeleteCandidate
): boolean {
  if (mode === 'off') {
    return false
  }
  if (candidate.trigger === 'close') {
    return true
  }
  return candidate.wasActive
    ? mode === 'close-or-exit' || mode === 'close-or-exit-background'
    : mode === 'close-or-exit-background'
}

/** Re-checked on every run: settings, workspace identity and tabs can all change while queued. */
export function resolveLastTabAutoDeleteTarget(
  state: AppState,
  candidate: LastTabAutoDeleteCandidate
): LastTabAutoDeleteTarget | null {
  const settings = state.settings
  if (
    !modeCoversCandidate(
      readLastTabAutoDeleteMode(settings?.deleteWorkspaceOnLastTabClose),
      candidate
    )
  ) {
    return null
  }
  const skipPinned = settings?.lastTabDeleteSkipPinned ?? true
  const skipSsh = settings?.lastTabDeleteSkipSsh ?? false
  const target = resolveTarget(state, candidate, { skipPinned, skipSsh })
  if (!target) {
    return null
  }
  if (target.kind === 'folder' && (settings?.lastTabDeleteSkipFolder ?? false)) {
    return null
  }
  if (state.reconcileWorktreeTabModel(candidate.workspaceKey).renderableTabCount !== 0) {
    return null
  }
  return target
}

function resolveTarget(
  state: AppState,
  candidate: LastTabAutoDeleteCandidate,
  skip: { skipPinned: boolean; skipSsh: boolean }
): LastTabAutoDeleteTarget | null {
  const scope = parseWorkspaceKey(candidate.workspaceKey)
  if (scope?.type === 'folder') {
    // Why the resolved host: the row's own executionHostId is often null and inherits its group's.
    const workspace = selectFolderWorkspaces(state).find(
      (row) =>
        row.id === scope.folderWorkspaceId &&
        getFolderWorkspaceHostId(row, state.projectGroups) === candidate.hostId
    )
    if (
      !workspace ||
      (skip.skipPinned && workspace.isPinned) ||
      (skip.skipSsh && parseExecutionHostId(candidate.hostId)?.kind === 'ssh')
    ) {
      return null
    }
    return {
      kind: 'folder',
      folderWorkspaceId: scope.folderWorkspaceId,
      ...(candidate.hostId ? { executionHostId: candidate.hostId } : {})
    }
  }

  const worktree = getWorktreeOnHostFromState(state, candidate.workspaceKey, candidate.hostId)
  if (
    !worktree ||
    worktree.instanceId !== candidate.instanceId ||
    worktree.isMainWorktree ||
    (skip.skipPinned && worktree.isPinned)
  ) {
    return null
  }
  if (skip.skipSsh && isSshWorktree(state, worktree)) {
    return null
  }
  return { kind: 'worktree', worktree }
}

function isSshWorktree(state: AppState, worktree: Worktree): boolean {
  if (parseExecutionHostId(worktree.hostId)?.kind === 'ssh') {
    return true
  }
  // Why any match when hostless: guessing the owner would read the focused host; skipping is safe.
  return state.repos.some(
    (repo) =>
      repo.id === worktree.repoId &&
      (!worktree.hostId || getRepoExecutionHostId(repo) === worktree.hostId) &&
      Boolean(repo.connectionId)
  )
}
