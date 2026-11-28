import { useCallback, useSyncExternalStore } from 'react'
import { useIndexShortcutHintVisible } from '@/lib/keyboard/index-shortcut-hints'
import { useAppStateValue } from '@/store/retained-views/app-state-view'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  getVisibleWorktreeShortcutTargets,
  subscribeVisibleWorktreeShortcutTargets
} from './visible-worktrees'

/** While the workspace "select 1–9" modifiers are held: the digit that reaches this row, if any. */
export function useWorktreeShortcutDigit(
  worktreeId: string,
  hostId: Worktree['hostId']
): string | undefined {
  const visible = useIndexShortcutHintVisible('workspace.selectByIndex')
  // The jump runs only in the terminal view (workspace-shortcut-ipc-bridge), so no digit elsewhere.
  const terminalView = useAppStateValue((state) => state.activeView === 'terminal')
  const shown = visible && terminalView
  const digit = useCallback((): string | undefined => {
    if (!shown) {
      return undefined
    }
    // Same list and host identity the shortcut indexes, so the badge never disagrees with the jump.
    const index = getVisibleWorktreeShortcutTargets()
      .slice(0, 9)
      .findIndex(
        (target) =>
          target.id === worktreeId && (target.executionHostId ?? null) === (hostId ?? null)
      )
    return index === -1 ? undefined : String(index + 1)
  }, [hostId, shown, worktreeId])
  return useSyncExternalStore(subscribeVisibleWorktreeShortcutTargets, digit)
}
