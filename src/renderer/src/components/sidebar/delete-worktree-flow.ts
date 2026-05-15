import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { getWorktreeMapFromState } from '@/store/selectors'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { getDeleteWorktreeToastCopy } from './delete-worktree-toast'
import type { Worktree } from '../../../../shared/types'

type WorktreeBatchDeleteOptions = {
  forceConfirm?: boolean
  onDeleted?: (worktreeIds: string[]) => void
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

export async function runWorktreeDeletesSequentially(
  targets: readonly Pick<Worktree, 'id' | 'displayName'>[]
): Promise<string[]> {
  const deletedIds: string[] = []
  for (const target of targets) {
    // Why: git worktree removals for one repo contend on git lock files.
    // Running the user-selected batch sequentially avoids partial lock races.
    const deleted = await runWorktreeDeleteWithToast(target.id, target.displayName)
    if (deleted) {
      deletedIds.push(target.id)
    }
  }
  return deletedIds
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
  worktreeName: string
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
                    }
                  })
                  .catch((err: unknown) => {
                    toast.error('Failed to delete worktree', {
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
      toast.error('Failed to delete worktree', {
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
 * Why folder mode is handled at the call site: folder-repo removal branches
 * to a different modal (`confirm-remove-folder`) and the folder-vs-git
 * determination requires the full Worktree record's repoId. Keeping that
 * decision adjacent to the caller (rather than branching inside this helper)
 * avoids bleeding folder-mode concerns into what is otherwise a simple
 * skip-confirm-vs-modal decision, and lets the context menu short-circuit
 * before ever entering this funnel.
 *
 * The main-worktree / missing-record guard here is defense-in-depth — the
 * caller is responsible for disabling UI when this is known ahead of time,
 * but we still refuse to act if the record disappeared between render and
 * click (e.g. a concurrent delete or state reset).
 */
export function runWorktreeDelete(worktreeId: string): void {
  const state = useAppStore.getState()
  const target = getWorktreeMapFromState(state).get(worktreeId) ?? null
  // Guard: main worktrees cannot be deleted, and a missing record means the
  // worktree was removed out from under us — either way, no-op silently
  // rather than opening a modal with stale/invalid context.
  if (!target || target.isMainWorktree) {
    return
  }
  state.clearWorktreeDeleteState(worktreeId)
  const skipConfirm = state.settings?.skipDeleteWorktreeConfirm ?? false
  if (skipConfirm) {
    void runWorktreeDeleteWithToast(worktreeId, target.displayName)
    return
  }
  state.openModal('delete-worktree', { worktreeId })
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
  const skipConfirm =
    !options.forceConfirm &&
    targets.length === 1 &&
    (state.settings?.skipDeleteWorktreeConfirm ?? false)
  if (skipConfirm) {
    void runWorktreeDeletesSequentially(targets).then((deletedIds) => {
      if (deletedIds.length > 0) {
        options.onDeleted?.(deletedIds)
      }
    })
    return true
  }

  if (targets.length === 1) {
    state.openModal('delete-worktree', {
      worktreeId: targets[0].id,
      ...(options.forceConfirm ? { allowSkipConfirm: false } : {}),
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
