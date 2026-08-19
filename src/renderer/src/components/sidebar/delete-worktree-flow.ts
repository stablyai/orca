import { useAppStore } from '@/store'
import { getAllWorktreesFromState, getWorktreeOnHostFromState } from '@/store/selectors'
import { toWorktreeRemovalTarget } from '../../../../shared/worktree/removal'
import { findRepoForHost } from '@/store/slices/repo-host-identity'
import {
  showNoDeletableWorkspacesToast,
  showWorkspaceListChangedToast
} from './stale-workspace-list-toast'
import { getWorkspaceDeleteLineage } from './workspace-delete-lineage'
import { resolveSshWorkspaceForget } from './ssh-workspace-forget-resolution'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import {
  resolveWorktreeBatchDeleteTargets,
  toWorktreeDeleteIdentities,
  type WorktreeBatchDeleteOptions,
  type WorktreeDeleteIdentity,
  type WorktreeDeleteOptions
} from './worktree-delete-request'
import {
  runWorktreeDeletesInParallel,
  runWorktreeDeleteWithToast
} from './worktree-delete-execution'

export { runWorktreeDeletesInParallel, runWorktreeDeleteWithToast }

/**
 * Shared funnel for the standard (non-folder) delete decision tree (WorktreeContextMenu,
 * MemoryStatusSegment); branches on the `skipDeleteWorktreeConfirm` preference.
 *
 * The missing-record and instance guards reject stale actions after concurrent state changes.
 */
export function runWorktreeDelete(worktreeId: string, options: WorktreeDeleteOptions = {}): void {
  const state = useAppStore.getState()
  // Why (STA-4343): the id-keyed map keeps one row per `repoId::path`, so a caller
  // acting on a specific sidebar row has to name that row's host — otherwise
  // deleting the SSH row destroys the local checkout at the same path. A caller
  // that names no host keeps the old first-wins behaviour.
  const target = getWorktreeOnHostFromState(state, worktreeId, options.expectedHostId) ?? null
  const instanceChanged =
    Object.hasOwn(options, 'expectedInstanceId') &&
    target?.instanceId !== options.expectedInstanceId
  if (!target || instanceChanged) {
    // Why: folder workspaces are never in the worktree map — their callers own that route, so a
    // miss there is a routing gap, not a stale list, and must not claim the workspace is gone.
    if (parseWorkspaceKey(worktreeId)?.type !== 'folder') {
      showWorkspaceListChangedToast()
    }
    return
  }
  if (target.isMainWorktree) {
    const repo = findRepoForHost(state.repos, target.repoId, {
      hostId: target.hostId,
      settings: state.settings
    })
    const hostId = repo ? getRepoExecutionHostId(repo) : target.hostId
    // Why: git refuses to delete the primary checkout; users can still remove the owning project from Orca (disk contents kept).
    state.openModal('confirm-remove-folder', {
      repoId: target.repoId,
      displayName: repo?.displayName ?? target.displayName,
      ...(hostId ? { hostId } : {})
    })
    return
  }
  if (target.hostId) {
    state.clearWorktreeDeleteState(worktreeId, target.hostId)
  } else {
    state.clearWorktreeDeleteState(worktreeId)
  }

  // Why: a disconnected SSH host has no provider, so worktrees:remove throws; route to reconnect-and-delete or local-only forget.
  // Skip on paired web/mobile clients: SSH state is desktop-only, so empty sshTargetLabels misclassifies SSH repos as ghosts; their worktree.rm RPC still handles the delete.
  const matchingRepos = state.repos.filter((entry) => entry.id === target.repoId)
  const repo = target.hostId
    ? findRepoForHost(matchingRepos, target.repoId, { hostId: target.hostId })
    : matchingRepos.length === 1
      ? matchingRepos[0]
      : null
  const sshResolution = isPairedWebClientWindow()
    ? { kind: 'not-ssh' as const }
    : resolveSshWorkspaceForget({
        repo,
        sshConnectionStates: state.sshConnectionStates,
        sshTargetLabels: state.sshTargetLabels
      })
  if (sshResolution.kind === 'ghost' || sshResolution.kind === 'disconnected') {
    // Why no lineage-children warning: forget-local is metadata-only per-worktree, so it can't fail on a still-registered child.
    state.openModal('forget-ssh-workspace', {
      worktreeId,
      displayName: target.displayName,
      resolution: sshResolution
    })
    return
  }

  const deleteLineage = getWorkspaceDeleteLineage(
    target,
    getAllWorktreesFromState(state),
    state.worktreeLineageById
  )
  const hasLineageChildren = deleteLineage.descendants.length > 0
  const skipConfirm = state.settings?.skipDeleteWorktreeConfirm ?? false
  if (skipConfirm && !hasLineageChildren) {
    void runWorktreeDeleteWithToast(toWorktreeRemovalTarget(target), target.displayName)
    return
  }
  state.openModal('delete-worktree', {
    worktreeId,
    worktreeDeleteIdentities: toWorktreeDeleteIdentities([target]),
    ...(hasLineageChildren
      ? {
          lineageDeleteIdentities: toWorktreeDeleteIdentities(deleteLineage.deleteAllTargets)
        }
      : {}),
    ...(hasLineageChildren ? { allowSkipConfirm: false } : {})
  })
}

export function runWorktreeBatchDelete(
  requestedWorktrees: readonly string[] | readonly WorktreeDeleteIdentity[],
  options: WorktreeBatchDeleteOptions = {}
): boolean {
  const state = useAppStore.getState()
  const targets = resolveWorktreeBatchDeleteTargets(requestedWorktrees, (worktreeId, hostId) =>
    getWorktreeOnHostFromState(state, worktreeId, hostId)
  )
  if (!targets) {
    showWorkspaceListChangedToast()
    return false
  }

  if (targets.length === 0) {
    showNoDeletableWorkspacesToast()
    return false
  }

  for (const target of targets) {
    if (target.hostId) {
      state.clearWorktreeDeleteState(target.id, target.hostId)
    } else {
      state.clearWorktreeDeleteState(target.id)
    }
  }

  // Why: bulk cleanup can destroy many directories at once, so batch/Space deletes keep an explicit confirmation step.
  const singleTargetLineage =
    targets.length === 1
      ? getWorkspaceDeleteLineage(
          targets[0],
          getAllWorktreesFromState(state),
          state.worktreeLineageById
        )
      : null
  const singleTargetHasLineageChildren = (singleTargetLineage?.descendants.length ?? 0) > 0
  const skipConfirm =
    !options.forceConfirm &&
    targets.length === 1 &&
    !singleTargetHasLineageChildren &&
    (state.settings?.skipDeleteWorktreeConfirm ?? false)
  if (skipConfirm) {
    void runWorktreeDeletesInParallel(targets, {
      onForceDeleted: (deletedTarget) => options.onDeleted?.([deletedTarget])
    }).then((deletedTargets) => {
      if (deletedTargets.length > 0) {
        options.onDeleted?.(deletedTargets)
      }
    })
    return true
  }

  if (targets.length === 1) {
    state.openModal('delete-worktree', {
      worktreeId: targets[0].id,
      worktreeDeleteIdentities: toWorktreeDeleteIdentities(targets),
      ...(singleTargetHasLineageChildren && singleTargetLineage
        ? {
            lineageDeleteIdentities: toWorktreeDeleteIdentities(
              singleTargetLineage.deleteAllTargets
            )
          }
        : {}),
      ...(options.forceConfirm || singleTargetHasLineageChildren
        ? { allowSkipConfirm: false }
        : {}),
      ...(options.onDeleted ? { onDeleted: options.onDeleted } : {}),
      ...(options.forceOnConfirm === false ? { forceOnConfirm: false } : {})
    })
    return true
  }

  state.openModal('delete-worktree', {
    worktreeIds: targets.map((target) => target.id),
    worktreeDeleteIdentities: toWorktreeDeleteIdentities(targets),
    allowSkipConfirm: false,
    ...(options.onDeleted ? { onDeleted: options.onDeleted } : {}),
    ...(options.forceOnConfirm === false ? { forceOnConfirm: false } : {})
  })
  return true
}
