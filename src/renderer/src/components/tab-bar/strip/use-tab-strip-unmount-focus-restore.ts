import { useEffect, useLayoutEffect, useRef } from 'react'
import { useAppStore } from '../../../store'
import { captureFocusBeforeRestore, restoreTabStripFocus } from './tab-strip-focus-restore'

/** Read at execution from the store, so a deferred restore never trusts a stale render. */
export function isGroupFocusedInStore(worktreeId: string, groupId: string): boolean {
  const state = useAppStore.getState()
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
  groupId
}: {
  open: boolean
  surface: HTMLElement | null
  activeId: string | null
  worktreeId: string
  groupId: string
}): void {
  const latestRef = useRef({ open, surface, activeId, worktreeId, groupId })
  useLayoutEffect(() => {
    latestRef.current = { open, surface, activeId, worktreeId, groupId }
  })
  useEffect(
    () => () => {
      const latest = latestRef.current
      if (!latest.open) {
        return
      }
      const focusBefore = captureFocusBeforeRestore()
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
