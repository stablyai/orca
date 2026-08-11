import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { getWorktreeMapFromState } from '@/store/selectors'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { translate } from '@/i18n/i18n'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../../../shared/cross-platform-path'
import type { Worktree } from '../../../../shared/types'
import { prepareActiveWorktreeFocusAfterDelete } from './active-worktree-focus-after-delete'
import { showDeleteWorktreeFailureToast } from './delete-worktree-failure-toast'
import { showWorkspaceListChangedToast } from './stale-workspace-list-toast'
import { showPreservedBranchBatchToast } from './preserved-branch-batch-toast'
import type { PreservedBranchCleanup } from '@/lib/preserved-branch-cleanup'
import type { WorktreeDeleteWithToastOptions } from './worktree-delete-request'

// A failed delete usually means unresolved changes, so land on the diff panel.
function viewWorktreeDiff(worktreeId: string): void {
  activateAndRevealWorktree(worktreeId)
  const state = useAppStore.getState()
  state.setRightSidebarTab('source-control')
  state.setRightSidebarOpen(true)
}

function isStrictDescendantPath(parentPath: string, childPath: string): boolean {
  return (
    normalizeRuntimePathForComparison(parentPath) !==
      normalizeRuntimePathForComparison(childPath) && isPathInsideOrEqual(parentPath, childPath)
  )
}

export async function runWorktreeDeletesInParallel(
  targets: readonly Pick<Worktree, 'id' | 'instanceId' | 'displayName' | 'repoId' | 'path'>[],
  options: WorktreeDeleteWithToastOptions = {}
): Promise<string[]> {
  // A destructive command must run once per identity even if a refresh duplicated rows.
  const uniqueTargets = Array.from(new Map(targets.map((target) => [target.id, target])).values())
  // Batch focus is committed once after every target settles.
  const activeWorktreeIdBefore = useAppStore.getState().activeWorktreeId
  const commitBatchFocus = activeWorktreeIdBefore
    ? prepareActiveWorktreeFocusAfterDelete(activeWorktreeIdBefore)
    : null
  // Mark all targets up front so the sidebar shows immediate progress.
  useAppStore.getState().markWorktreesDeleting(uniqueTargets.map((target) => target.id))
  // Git worktree removal shares repo locks, while separate repos can proceed in parallel.
  const groups = new Map<string, (typeof uniqueTargets)[number][]>()
  for (const target of uniqueTargets) {
    const group = groups.get(target.repoId)
    if (group) {
      group.push(target)
    } else {
      groups.set(target.repoId, [target])
    }
  }
  for (const group of groups.values()) {
    // Children must leave first or Git rejects their registered ancestor.
    group.sort((a, b) => b.path.length - a.path.length)
  }
  const preservedBranches: PreservedBranchCleanup[] = []
  const aggregatePreservedBranches = uniqueTargets.length > 1
  let listChanged = false
  const groupResults = await Promise.all(
    Array.from(groups.values()).map(async (group) => {
      const deletedInGroup: string[] = []
      const failedInGroup: (typeof group)[number][] = []
      for (const target of group) {
        // A queued target may be recreated while an earlier repo sibling is deleting.
        const currentTarget = getWorktreeMapFromState(useAppStore.getState()).get(target.id)
        if (!currentTarget || currentTarget.instanceId !== target.instanceId) {
          useAppStore.getState().clearWorktreeDeleteState(target.id)
          listChanged = true
          continue
        }
        if (failedInGroup.some((failed) => isStrictDescendantPath(target.path, failed.path))) {
          useAppStore.getState().clearWorktreeDeleteState(target.id)
          continue
        }
        const deleted = await runWorktreeDeleteWithToast(target.id, target.displayName, {
          ...options,
          focusSuccessorOnDelete: false,
          suppressPreservedBranchToast: aggregatePreservedBranches,
          onPreservedBranch: (branch) => {
            preservedBranches.push(branch)
            options.onPreservedBranch?.(branch)
          }
        })
        if (deleted) {
          deletedInGroup.push(target.id)
        } else {
          // A failed child makes deleting its ancestor unsafe because the child lives below it.
          failedInGroup.push(target)
        }
      }
      return deletedInGroup
    })
  )
  if (listChanged) {
    showWorkspaceListChangedToast()
  }
  const deletedSet = new Set(groupResults.flat())
  // Intermediate focus can spawn a terminal in another target that is still queued.
  if (activeWorktreeIdBefore && deletedSet.has(activeWorktreeIdBefore)) {
    commitBatchFocus?.()
  }
  if (aggregatePreservedBranches && preservedBranches.length > 0) {
    const targetOrder = new Map(uniqueTargets.map((target, index) => [target.id, index]))
    preservedBranches.sort(
      (left, right) =>
        (targetOrder.get(left.worktreeId) ?? Number.MAX_SAFE_INTEGER) -
        (targetOrder.get(right.worktreeId) ?? Number.MAX_SAFE_INTEGER)
    )
    showPreservedBranchBatchToast(deletedSet.size, preservedBranches)
  }
  return uniqueTargets.filter((target) => deletedSet.has(target.id)).map((target) => target.id)
}

/** Shared confirmed and skip-confirm execution with consistent failure recovery. */
export function runWorktreeDeleteWithToast(
  worktreeId: string,
  worktreeName: string,
  options: WorktreeDeleteWithToastOptions = {}
): Promise<boolean> {
  const removeWorktree = useAppStore.getState().removeWorktree
  const commitFocus = prepareActiveWorktreeFocusAfterDelete(worktreeId)
  const focusSuccessor = options.focusSuccessorOnDelete !== false

  const removal = options.suppressPreservedBranchToast
    ? removeWorktree(worktreeId, options.force === true, { suppressPreservedBranchToast: true })
    : removeWorktree(worktreeId, options.force === true)
  return removal
    .then((result) => {
      if (result.ok) {
        if (result.preservedBranch) {
          options.onPreservedBranch?.({
            worktreeId,
            branchName: result.preservedBranch.branchName,
            expectedHead: result.preservedBranch.head,
            ...(result.preservedBranch.hostId ? { hostId: result.preservedBranch.hostId } : {}),
            ...(result.preservedBranch.runtimeEnvironmentId
              ? { runtimeEnvironmentId: result.preservedBranch.runtimeEnvironmentId }
              : {})
          })
        }
        if (focusSuccessor) {
          commitFocus()
        }
        return true
      }
      const state = useAppStore.getState().deleteStateByWorktreeId[worktreeId]
      const canForceDelete = state?.canForceDelete ?? false
      const hasKnownChanges =
        (useAppStore.getState().gitStatusByWorktree[worktreeId]?.length ?? 0) > 0
      showDeleteWorktreeFailureToast({
        error: result.error,
        canForceDelete,
        forceDeleteReason: state?.forceDeleteReason ?? null,
        lockReason: state?.lockReason ?? null,
        hasKnownChanges,
        onViewChanges: () => viewWorktreeDiff(worktreeId),
        onForceDelete: () => {
          // Recapture focus because the user may have navigated while the toast was open.
          const commitForceFocus = prepareActiveWorktreeFocusAfterDelete(worktreeId)
          // The explicit Force Delete retry may waive an unverified PTY-stop proof.
          const forceRemoval = useAppStore
            .getState()
            .removeWorktree(worktreeId, true, { allowUnverifiedPtyStop: true })
          forceRemoval
            .then((forceResult) => {
              if (!forceResult.ok) {
                toast.error(
                  translate(
                    'auto.components.sidebar.delete.worktree.flow.4f3876c0f5',
                    'Force delete failed'
                  ),
                  {
                    description: forceResult.error,
                    action: {
                      label: translate(
                        'auto.components.sidebar.delete.worktree.flow.7488ed8711',
                        'View'
                      ),
                      onClick: () => viewWorktreeDiff(worktreeId)
                    }
                  }
                )
                return
              }
              commitForceFocus()
              options.onForceDeleted?.(worktreeId)
            })
            .catch((err: unknown) => {
              toast.error(
                translate(
                  'auto.components.sidebar.delete.worktree.flow.ae57cbf6e4',
                  'Failed to delete workspace'
                ),
                {
                  description: err instanceof Error ? err.message : String(err),
                  action: {
                    label: translate(
                      'auto.components.sidebar.delete.worktree.flow.7488ed8711',
                      'View'
                    ),
                    onClick: () => viewWorktreeDiff(worktreeId)
                  }
                }
              )
            })
        },
        worktreeId,
        worktreeName
      })
      return false
    })
    .catch((err: unknown) => {
      toast.error(
        translate(
          'auto.components.sidebar.delete.worktree.flow.ae57cbf6e4',
          'Failed to delete workspace'
        ),
        { description: err instanceof Error ? err.message : String(err) }
      )
      return false
    })
}
