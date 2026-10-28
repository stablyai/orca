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
import { getWorktreeExecutionHostId } from '../../../../shared/execution-host'
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
import { collectRemovalUnsavedFiles } from '@/components/editor/removal-unsaved-editor-files'

export { runWorktreeDeletesInParallel, runWorktreeDeleteWithToast }

/** Standard Git-worktree deletion funnel; stale record/instance guards precede confirmation preferences. */
export function runWorktreeDelete(worktreeId: string, options: WorktreeDeleteOptions = {}): void {
  const state = useAppStore.getState()
  // Qualify row actions by host; an unqualified id shared by two hosts resolves to nothing, never the first copy.
  const target = getWorktreeOnHostFromState(state, worktreeId, options.expectedHostId) ?? null
  const instanceChanged =
    Object.hasOwn(options, 'expectedInstanceId') &&
    target?.instanceId !== options.expectedInstanceId
  if (!target || instanceChanged) {
    // Folder callers own another deletion route; missing Git records cannot establish that those workspaces vanished.
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
    // Git cannot remove primary checkouts; offer project removal while retaining files on disk.
    state.openModal('confirm-remove-folder', {
      repoId: target.repoId,
      displayName: repo?.displayName ?? target.displayName,
      hostId: getWorktreeExecutionHostId(target, repo ?? undefined)
    })
    return
  }
  if (target.hostId) {
    state.clearWorktreeDeleteState(worktreeId, target.hostId)
  } else {
    state.clearWorktreeDeleteState(worktreeId)
  }

  // Disconnected SSH needs reconnect/forget; paired clients lack desktop SSH metadata, so their RPC must handle deletion instead.
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
    // Metadata-only forgetting cannot fail on registered lineage children, so skip their removal warning.
    state.openModal('forget-ssh-workspace', {
      worktreeId,
      // Why (STA-11912): the reconnect awaits a connection, so the removal must stay pinned to this incarnation.
      worktreeDeleteIdentities: toWorktreeDeleteIdentities([target]),
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
  // Skip-confirm preferences never authorize discarding unsaved editor text.
  const skipConfirm =
    (state.settings?.skipDeleteWorktreeConfirm ?? false) &&
    collectRemovalUnsavedFiles(useAppStore.getState, [target]).length === 0
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

  // Bulk removal can destroy multiple directories; retain explicit confirmation.
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
    (state.settings?.skipDeleteWorktreeConfirm ?? false) &&
    collectRemovalUnsavedFiles(useAppStore.getState, targets).length === 0
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
