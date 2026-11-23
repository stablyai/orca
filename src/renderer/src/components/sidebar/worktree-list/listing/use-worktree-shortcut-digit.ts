import { useIndexShortcutHintVisible } from '@/lib/keyboard/index-shortcut-hints'
import { getVisibleWorktreeShortcutTargets } from './visible-worktrees'

/** While the workspace "select 1–9" modifiers are held: the digit that reaches this row, if any. */
export function useWorktreeShortcutDigit(worktreeId: string): string | undefined {
  const visible = useIndexShortcutHintVisible('workspace.selectByIndex')
  if (!visible) {
    return undefined
  }
  // Same list the shortcut indexes (workspace-shortcut-ipc-bridge), so the badge never disagrees with the jump.
  const index = getVisibleWorktreeShortcutTargets()
    .slice(0, 9)
    .findIndex((target) => target.id === worktreeId)
  return index === -1 ? undefined : String(index + 1)
}
