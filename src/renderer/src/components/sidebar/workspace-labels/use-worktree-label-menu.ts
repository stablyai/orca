import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store/index'
import type { Worktree } from '../../../../../shared/worktree/types'
import { planLabelToggle } from './plan-label-toggle'

type AppState = ReturnType<typeof useAppStore.getState>

const NO_LABEL_IDS: readonly string[] = []
const NO_CONTEXT_LABEL_IDS: readonly (readonly string[])[] = []

// Why: the menu's context is a snapshot from when it opened; reading the store lets toggles in one visit build on each other.
function currentLabelIds(state: AppState, worktree: Worktree): readonly string[] {
  return state.getKnownWorktreeById(worktree.id, worktree.hostId)?.labelIds ?? NO_LABEL_IDS
}

// shortcut: folder workspaces update the store only after their save returns, so two clicks inside one
// remote round trip can drop the first; track pending writes here if remote folder labels show that.
function applyLabelToggle(
  updateWorktreeMeta: AppState['updateWorktreeMeta'],
  worktrees: readonly Worktree[],
  labelId: string
): void {
  const state = useAppStore.getState()
  const targets = worktrees.flatMap((w) =>
    state.getKnownWorktreeById(w.id, w.hostId)
      ? [{ id: w.id, hostId: w.hostId, labelIds: currentLabelIds(state, w) }]
      : []
  )
  void Promise.all(
    planLabelToggle(targets, labelId).map((target) =>
      updateWorktreeMeta(
        target.id,
        { labelIds: target.labelIds },
        { executionHostId: target.hostId ?? 'local' }
      )
    )
  ).then((results) => {
    const failure = results.find((result) => !result.ok)
    if (failure && !failure.ok) {
      toast.error(failure.error)
    }
  })
}

export function useWorktreeLabelMenu(args: {
  activeContextWorktrees: readonly Worktree[]
  menuOpen: boolean
  updateWorktreeMeta: AppState['updateWorktreeMeta']
}) {
  const { activeContextWorktrees, menuOpen, updateWorktreeMeta } = args
  const workspaceLabels = useAppStore((s) => s.workspaceLabels)
  // Closed menus select a constant, so idle cards don't re-render on store changes.
  const contextLabelIds = useAppStore(
    useShallow((s) =>
      menuOpen ? activeContextWorktrees.map((w) => currentLabelIds(s, w)) : NO_CONTEXT_LABEL_IDS
    )
  )
  // Why: once the menu closes, the context falls back to the selection, which may not be what was right-clicked.
  const [newLabelTargets, setNewLabelTargets] = useState<readonly Worktree[] | null>(null)

  const checkedLabelIds = useMemo(
    () =>
      new Set(
        workspaceLabels
          .filter(
            (label) =>
              contextLabelIds.length > 0 && contextLabelIds.every((ids) => ids.includes(label.id))
          )
          .map((label) => label.id)
      ),
    [contextLabelIds, workspaceLabels]
  )

  const handleToggleWorkspaceLabel = useCallback(
    (labelId: string) => applyLabelToggle(updateWorktreeMeta, activeContextWorktrees, labelId),
    [activeContextWorktrees, updateWorktreeMeta]
  )

  const handleNewWorkspaceLabel = useCallback(
    () => setNewLabelTargets(activeContextWorktrees),
    [activeContextWorktrees]
  )

  const handleNewLabelDialogOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setNewLabelTargets(null)
    }
  }, [])

  const handleSubmitNewWorkspaceLabel = useCallback(
    (name: string, color: string): void => {
      const label = useAppStore.getState().addWorkspaceLabel(name, color)
      if (!label) {
        return
      }
      applyLabelToggle(updateWorktreeMeta, newLabelTargets ?? [], label.id)
      handleNewLabelDialogOpenChange(false)
    },
    [handleNewLabelDialogOpenChange, newLabelTargets, updateWorktreeMeta]
  )

  return {
    workspaceLabels,
    checkedLabelIds,
    newLabelDialogOpen: newLabelTargets !== null,
    handleToggleWorkspaceLabel,
    handleNewWorkspaceLabel,
    handleNewLabelDialogOpenChange,
    handleSubmitNewWorkspaceLabel
  }
}
