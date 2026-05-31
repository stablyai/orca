import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { getWorktreeMapFromState } from '@/store/selectors'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { getDeleteWorktreeToastCopy } from './delete-worktree-toast'
import { getWorkspaceDeleteLineage } from './workspace-delete-lineage'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../../../shared/cross-platform-path'
import type { Worktree } from '../../../../shared/types'

type WorktreeBatchDeleteOptions = {
  forceConfirm?: boolean
  onDeleted?: (worktreeIds: string[]) => void
}

type WorktreeDeleteWithToastOptions = {
  onForceDeleted?: (worktreeId: string) => void
}

// Why: a failed delete almost always means the worktree still has changes
// that need attention (uncommitted work, unpushed commits, conflicts). The
// "View" affordance should surface those changes directly, not just bring
// the worktree into focus, so the user lands on the diff panel where the
// blocking work is visible.
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
  // Why: `git worktree remove`/`prune`/`branch -D` mutate repo-wide ref state
  // and contend on `.git/packed-refs.lock` and per-worktree HEAD.lock. Running
  // every target through Promise.all races those locks on the same repo and
  // intermittently fails one or more deletes. Serialize per repoId while
  // still letting deletes across different repos run concurrently.
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
    // Why: selected parent+child workspace deletes must remove nested children
    // first. Otherwise the parent delete is correctly rejected because it still
    // contains another registered worktree.
    group.sort((a, b) => b.path.length - a.path.length)
  }
  const groupResults = await Promise.all(
    Array.from(groups.values()).map(async (group) => {
      const deletedInGroup: string[] = []
      const failedInGroup: (typeof group)[number][] = []
      for (const target of group) {
        if (failedInGroup.some((failed) => isStrictDescendantPath(target.path, failed.path))) {
          continue
        }
        const deleted = await runWorktreeDeleteWithToast(target.id, target.displayName, options)
        if (deleted) {
          deletedInGroup.push(target.id)
        } else {
          // Why: after a descendant delete fails, deleting an ancestor can still
          // remove that child from disk when it lives under the parent directory.
          failedInGroup.push(target)
        }
      }
      return deletedInGroup
    })
  )
  const deletedSet = new Set(groupResults.flat())
  return targets.filter((target) => deletedSet.has(target.id)).map((target) => target.id)
}

/**
 * Shared delete-with-toast flow used by both DeleteWorktreeDialog (confirm
 * path) and WorktreeContextMenu (skip-confirm path). Centralizes the error
 * toast copy, the "Force Delete" action wiring, and the "View" affordance so
 * both entry points behave identically from the user's perspective.
 *
 * Why this is a module helper rather than a store action: the behavior is
 * intrinsically UI-shaped — it shows sonner toasts, registers action/cancel
 * handlers, and depends on `activateAndRevealWorktree` (a renderer-only
 * helper). Keeping it in the renderer layer avoids bleeding toast/UI
 * concerns into the store slice while still preventing the two delete
 * entry points from drifting apart.
 */
export function runWorktreeDeleteWithToast(
  worktreeId: string,
  worktreeName: string,
  options: WorktreeDeleteWithToastOptions = {}
): Promise<boolean> {
  const removeWorktree = useAppStore.getState().removeWorktree

  return removeWorktree(worktreeId, false)
    .then((result) => {
      if (result.ok) {
        return true
      }
      const state = useAppStore.getState().deleteStateByWorktreeId[worktreeId]
      const canForceDelete = state?.canForceDelete ?? false
      const toastCopy = getDeleteWorktreeToastCopy(worktreeName, canForceDelete, result.error)
      const showToast = toastCopy.isDestructive ? toast.error : toast.info
      showToast(toastCopy.title, {
        description: toastCopy.description,
        duration: 10000,
        cancel: {
          label: 'View',
          onClick: () => viewWorktreeDiff(worktreeId)
        },
        action: canForceDelete
          ? {
              label: 'Force Delete',
              onClick: () => {
                useAppStore
                  .getState()
                  .removeWorktree(worktreeId, true)
                  .then((forceResult) => {
                    if (!forceResult.ok) {
                      toast.error('Force delete failed', {
                        description: forceResult.error,
                        action: {
                          label: 'View',
                          onClick: () => viewWorktreeDiff(worktreeId)
                        }
                      })
                      return
                    }
                    options.onForceDeleted?.(worktreeId)
                  })
                  .catch((err: unknown) => {
                    toast.error('Failed to delete workspace', {
                      description: err instanceof Error ? err.message : String(err),
                      action: {
                        label: 'View',
                        onClick: () => viewWorktreeDiff(worktreeId)
                      }
                    })
                  })
              }
            }
          : undefined
      })
      return false
    })
    .catch((err: unknown) => {
      toast.error('Failed to delete workspace', {
        description: err instanceof Error ? err.message : String(err)
      })
      return false
    })
}

/**
 * Shared funnel for the standard (non-folder) delete decision tree, called
 * from both WorktreeContextMenu and MemoryStatusSegment. Mirrors the
 * `runSleepWorktree` pattern: reads state imperatively so the helper can be
 * invoked from any handler without plumbing selectors through props, then
 * branches on the user's `skipDeleteWorktreeConfirm` preference — either
 * running the delete immediately with toast feedback, or opening the
 * confirmation modal.
 *
 * The missing-record guard here is defense-in-depth — the caller is
 * responsible for disabling UI when this is known ahead of time, but we still
 * refuse to act if the record disappeared between render and click (e.g. a
 * concurrent delete or state reset).
 */
export function runWorktreeDelete(worktreeId: string): void {
  const state = useAppStore.getState()
  const target = getWorktreeMapFromState(state).get(worktreeId) ?? null
  if (!target) {
    return
  }
  if (target.isMainWorktree) {
    const repo = state.repos.find((entry) => entry.id === target.repoId)
    // Why: git refuses to delete the primary checkout, but users can still
    // remove the owning project from Orca without deleting disk contents.
    state.openModal('confirm-remove-folder', {
      repoId: target.repoId,
      displayName: repo?.displayName ?? target.displayName
    })
    return
  }
  state.clearWorktreeDeleteState(worktreeId)
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
    toast.info('No deletable workspaces selected', {
      description: 'Refresh Space and try again if the workspace list looks stale.'
    })
    return false
  }

  for (const target of targets) {
    state.clearWorktreeDeleteState(target.id)
  }

  // Why: bulk cleanup can destroy many directories at once, so batch deletes
  // and Space-triggered deletes must keep an explicit confirmation step.
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
