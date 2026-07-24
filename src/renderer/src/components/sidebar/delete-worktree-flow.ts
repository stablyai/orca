import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { getWorktreeMapFromState } from '@/store/selectors'
import { findRepoForHost } from '@/store/slices/repo-host-identity'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { prepareActiveWorktreeFocusAfterDelete } from './active-worktree-focus-after-delete'
import { showDeleteWorktreeFailureToast } from './delete-worktree-failure-toast'
import { getWorkspaceDeleteLineage } from './workspace-delete-lineage'
import { resolveSshWorkspaceForget } from './ssh-workspace-forget-resolution'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../../../shared/cross-platform-path'
import type { Worktree } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'

type WorktreeBatchDeleteOptions = {
  forceConfirm?: boolean
  onDeleted?: (worktreeIds: string[]) => void
}

type WorktreeDeleteWithToastOptions = {
  force?: boolean
  onForceDeleted?: (worktreeId: string) => void
  // Why: batch deletes suppress the per-delete focus handoff to focus one survivor after the batch (see runWorktreeDeletesInParallel).
  focusSuccessorOnDelete?: boolean
}

// Why: a failed delete usually means unresolved changes, so land on the diff panel, not just focus the worktree.
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
  targets: readonly Pick<Worktree, 'id' | 'displayName' | 'repoId' | 'path'>[],
  options: WorktreeDeleteWithToastOptions = {}
): Promise<string[]> {
  // Why: capture the viewed workspace before any delete so we can focus one survivor after the batch settles, not per delete.
  const activeWorktreeIdBefore = useAppStore.getState().activeWorktreeId
  const commitBatchFocus = activeWorktreeIdBefore
    ? prepareActiveWorktreeFocusAfterDelete(activeWorktreeIdBefore)
    : null
  // Why: mark every target deleting up front for immediate in-flight feedback, even though deletes serialize per repo.
  useAppStore.getState().markWorktreesDeleting(targets.map((target) => target.id))
  // Why: worktree remove/prune/branch -D race on shared ref locks; group by repoId to serialize per repo (cross-repo stays parallel).
  const groups = new Map<string, (typeof targets)[number][]>()
  for (const target of targets) {
    const group = groups.get(target.repoId)
    if (group) {
      group.push(target)
    } else {
      groups.set(target.repoId, [target])
    }
  }
  for (const group of groups.values()) {
    // Why: delete nested children first — else the parent delete is rejected while it still contains a registered worktree.
    group.sort((a, b) => b.path.length - a.path.length)
  }
  const groupResults = await Promise.all(
    Array.from(groups.values()).map(async (group) => {
      const deletedInGroup: string[] = []
      const failedInGroup: (typeof group)[number][] = []
      for (const target of group) {
        if (failedInGroup.some((failed) => isStrictDescendantPath(target.path, failed.path))) {
          useAppStore.getState().clearWorktreeDeleteState(target.id)
          continue
        }
        const deleted = await runWorktreeDeleteWithToast(target.id, target.displayName, {
          ...options,
          focusSuccessorOnDelete: false
        })
        if (deleted) {
          deletedInGroup.push(target.id)
        } else {
          // Why: after a descendant delete fails, deleting an ancestor can still remove that child from disk (it lives under the parent).
          failedInGroup.push(target)
        }
      }
      return deletedInGroup
    })
  )
  const deletedSet = new Set(groupResults.flat())
  // Why: focus a survivor once after the batch settles — an intermediate focus could spawn a terminal in a to-be-deleted workspace.
  if (activeWorktreeIdBefore && deletedSet.has(activeWorktreeIdBefore)) {
    commitBatchFocus?.()
  }
  return targets.filter((target) => deletedSet.has(target.id)).map((target) => target.id)
}

/**
 * Shared delete-with-toast flow for both DeleteWorktreeDialog (confirm) and
 * WorktreeContextMenu (skip-confirm), so both entry points behave identically.
 *
 * A renderer-layer helper (not a store action) to keep UI concerns out of the store slice.
 */
export function runWorktreeDeleteWithToast(
  worktreeId: string,
  worktreeName: string,
  options: WorktreeDeleteWithToastOptions = {}
): Promise<boolean> {
  const removeWorktree = useAppStore.getState().removeWorktree
  const commitFocus = prepareActiveWorktreeFocusAfterDelete(worktreeId)
  const focusSuccessor = options.focusSuccessorOnDelete !== false

  return removeWorktree(worktreeId, options.force === true)
    .then((result) => {
      if (result.ok) {
        // Why: keep the user on a live workspace instead of the Landing screen when they delete the one they were viewing.
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
          // Why: recapture at click time — the user may have navigated away while the toast was open, so focus only hands off if still viewed.
          const commitForceFocus = prepareActiveWorktreeFocusAfterDelete(worktreeId)
          const forceRemoval = useAppStore.getState().removeWorktree(worktreeId, true)
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
        {
          description: err instanceof Error ? err.message : String(err)
        }
      )
      return false
    })
}

/**
 * Shared funnel for the standard (non-folder) delete decision tree (WorktreeContextMenu,
 * MemoryStatusSegment); branches on the `skipDeleteWorktreeConfirm` preference.
 *
 * The missing-record guard is defense-in-depth: refuse to act if the record vanished
 * between render and click (concurrent delete or state reset).
 */
export function runWorktreeDelete(worktreeId: string): void {
  const state = useAppStore.getState()
  const target = getWorktreeMapFromState(state).get(worktreeId) ?? null
  if (!target) {
    return
  }
  if (target.isMainWorktree) {
    const repo = state.repos.find((entry) => entry.id === target.repoId)
    // Why: git refuses to delete the primary checkout; users can still remove the owning project from Orca (disk contents kept).
    state.openModal('confirm-remove-folder', {
      repoId: target.repoId,
      displayName: repo?.displayName ?? target.displayName
    })
    return
  }
  state.clearWorktreeDeleteState(worktreeId)

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

  const hasLineageChildren =
    getWorkspaceDeleteLineage(target, state.allWorktrees(), state.worktreeLineageById).descendants
      .length > 0
  const skipConfirm = state.settings?.skipDeleteWorktreeConfirm ?? false
  if (skipConfirm && !hasLineageChildren) {
    void runWorktreeDeleteWithToast(worktreeId, target.displayName)
    return
  }
  state.openModal('delete-worktree', {
    worktreeId,
    ...(hasLineageChildren ? { allowSkipConfirm: false } : {})
  })
}

export function runWorktreeBatchDelete(
  worktreeIds: readonly string[],
  options: WorktreeBatchDeleteOptions = {}
): boolean {
  const state = useAppStore.getState()
  const worktreeMap = getWorktreeMapFromState(state)
  const targets = worktreeIds
    .map((id) => worktreeMap.get(id) ?? null)
    .filter((worktree): worktree is Worktree => worktree != null && !worktree.isMainWorktree)

  if (targets.length === 0) {
    toast.info(
      translate(
        'auto.components.sidebar.delete.worktree.flow.7243145cd6',
        'No deletable workspaces selected'
      ),
      {
        description: translate(
          'auto.components.sidebar.delete.worktree.flow.b81b4e40ca',
          'Refresh Space and try again if the workspace list looks stale.'
        )
      }
    )
    return false
  }

  for (const target of targets) {
    state.clearWorktreeDeleteState(target.id)
  }

  // Why: bulk cleanup can destroy many directories at once, so batch/Space deletes keep an explicit confirmation step.
  const singleTargetHasLineageChildren =
    targets.length === 1 &&
    getWorkspaceDeleteLineage(targets[0], state.allWorktrees(), state.worktreeLineageById)
      .descendants.length > 0
  const skipConfirm =
    !options.forceConfirm &&
    targets.length === 1 &&
    !singleTargetHasLineageChildren &&
    (state.settings?.skipDeleteWorktreeConfirm ?? false)
  if (skipConfirm) {
    void runWorktreeDeletesInParallel(targets, {
      onForceDeleted: (deletedId) => options.onDeleted?.([deletedId])
    }).then((deletedIds) => {
      if (deletedIds.length > 0) {
        options.onDeleted?.(deletedIds)
      }
    })
    return true
  }

  if (targets.length === 1) {
    state.openModal('delete-worktree', {
      worktreeId: targets[0].id,
      ...(options.forceConfirm || singleTargetHasLineageChildren
        ? { allowSkipConfirm: false }
        : {}),
      ...(options.onDeleted ? { onDeleted: options.onDeleted } : {})
    })
    return true
  }

  state.openModal('delete-worktree', {
    worktreeIds: targets.map((target) => target.id),
    allowSkipConfirm: false,
    ...(options.onDeleted ? { onDeleted: options.onDeleted } : {})
  })
  return true
}
