import { useAppStore } from '@/store'
import {
  getVisibleWorktreeShortcutTargets,
  type VisibleWorktreeShortcutTarget
} from '../worktree-list/listing/visible-worktrees'

/** A bot row as the Bots section lists it; `open` does what clicking the row does. */
export type BotNumberShortcutTarget = {
  entryKey: string
  open: () => void
}

export type SidebarNumberShortcutTarget =
  | { kind: 'worktree'; target: VisibleWorktreeShortcutTarget }
  | { kind: 'bot'; target: BotNumberShortcutTarget }

// null while the Bots section is unmounted; [] while it is folded or searching.
let publishedBotTargets: readonly BotNumberShortcutTarget[] | null = null

export function setBotNumberShortcutTargets(
  targets: readonly BotNumberShortcutTarget[] | null
): void {
  publishedBotTargets = targets
}

/** Every row Cmd/Ctrl+1–9 addresses, in the order the sidebar stacks the Bots section and the workspace list. */
export function getSidebarNumberShortcutTargets(): SidebarNumberShortcutTarget[] {
  const worktrees = getVisibleWorktreeShortcutTargets().map(
    (target): SidebarNumberShortcutTarget => ({ kind: 'worktree', target })
  )
  const bots = (publishedBotTargets ?? []).map((target): SidebarNumberShortcutTarget => ({
    kind: 'bot',
    target
  }))
  return useAppStore.getState().sidebarProjectsFirst
    ? [...worktrees, ...bots]
    : [...bots, ...worktrees]
}

export function workspaceRowNumberHintKey(rowKey: string): string {
  return `row:${rowKey}`
}

export function botRowNumberHintKey(entryKey: string): string {
  return `bot:${entryKey}`
}

/** The key the target's sidebar row renders its number under; null when no row is mounted for it. */
export function sidebarNumberHintKey(target: SidebarNumberShortcutTarget): string | null {
  if (target.kind === 'bot') {
    return botRowNumberHintKey(target.target.entryKey)
  }
  return target.target.rowKey ? workspaceRowNumberHintKey(target.target.rowKey) : null
}
