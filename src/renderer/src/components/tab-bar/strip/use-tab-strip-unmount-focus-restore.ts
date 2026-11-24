import { useLayoutEffect, useRef } from 'react'
import { resolveFloatingWorkspaceSurfaceModel } from '@/components/floating-terminal/workspace/floating-workspace-surface-model'
import { selectFloatingWorkspacePanelVisible } from '@/store/workspaces/floating/floating-workspace-panel-selector'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/workspace/identity/floating-workspace-id'
import { useAppStore } from '../../../store'
import { captureTabStripMenuFocus, restoreTabStripFocus } from './tab-strip-focus-restore'

/** Read at execution from the store, so a deferred restore never trusts a stale render. */
export function isGroupFocusedInStore(worktreeId: string, groupId: string): boolean {
  const state = useAppStore.getState()
  if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    if (!selectFloatingWorkspacePanelVisible(state)) {
      return false
    }
    const current = resolveFloatingWorkspaceSurfaceModel(state)
    return current.kind === 'workspace' && current.focusedGroupId === groupId
  }
  return (
    state.activeWorktreeId === worktreeId && state.activeGroupIdByWorktree[worktreeId] === groupId
  )
}

/** A resize that removes the "+N" chip while its list is open keeps focus in the strip, if the group still owns it. */
export function useTabStripUnmountFocusRestore({
  open,
  surface,
  activeId,
  worktreeId,
  groupId,
  menuId
}: {
  open: boolean
  surface: HTMLElement | null
  activeId: string | null
  worktreeId: string
  groupId: string
  menuId: string
}): void {
  const latestRef = useRef({ open, surface, activeId, worktreeId, groupId, menuId })
  useLayoutEffect(() => {
    latestRef.current = { open, surface, activeId, worktreeId, groupId, menuId }
  })
  useLayoutEffect(
    () => () => {
      const latest = latestRef.current
      if (!latest.open) {
        return
      }
      const focusBefore = captureTabStripMenuFocus(latest.surface, latest.menuId)
      if (!focusBefore) {
        return
      }
      requestAnimationFrame(() =>
        restoreTabStripFocus({
          strip: latest.surface,
          slotId: latest.activeId,
          stillOwned: () => isGroupFocusedInStore(latest.worktreeId, latest.groupId),
          focusBefore
        })
      )
    },
    []
  )
}
