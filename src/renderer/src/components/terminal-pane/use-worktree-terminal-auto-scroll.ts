import { useEffect } from 'react'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import {
  SET_WORKTREE_TERMINAL_AUTO_SCROLL_EVENT,
  type SetWorktreeTerminalAutoScrollDetail
} from '@/constants/terminal'
import { followTerminalOutput, pinTerminalOutput } from './terminal-auto-scroll'

export function setMountedWorktreeTerminalAutoScroll(
  detail: SetWorktreeTerminalAutoScrollDetail | undefined,
  worktreeId: string,
  manager: PaneManager | null
): boolean {
  if (!detail?.worktreeIds.includes(worktreeId) || !manager) {
    return false
  }
  for (const pane of manager.getPanes()) {
    if (detail.enabled) {
      followTerminalOutput(pane.terminal)
    } else {
      pinTerminalOutput(pane.terminal)
    }
  }
  return true
}

export function useWorktreeTerminalAutoScroll(
  worktreeId: string,
  managerRef: React.RefObject<PaneManager | null>
): void {
  useEffect(() => {
    const handleAutoScroll = (event: Event): void => {
      setMountedWorktreeTerminalAutoScroll(
        (event as CustomEvent<SetWorktreeTerminalAutoScrollDetail | undefined>).detail,
        worktreeId,
        managerRef.current
      )
    }
    window.addEventListener(SET_WORKTREE_TERMINAL_AUTO_SCROLL_EVENT, handleAutoScroll)
    return () =>
      window.removeEventListener(SET_WORKTREE_TERMINAL_AUTO_SCROLL_EVENT, handleAutoScroll)
  }, [managerRef, worktreeId])
}
