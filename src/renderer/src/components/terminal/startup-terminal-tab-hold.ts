import {
  applyBackgroundMountTabRestriction,
  collectDeferredMountTabIds
} from './background-terminal-worktree-mount'

export type StartupTerminalTabHold = {
  worktreeId: string
  /** Tabs the hold keeps unmounted — parked-equivalent, so watchers own their side effects. */
  heldTabIds: ReadonlySet<string>
}

/** Release before activation planning so it cannot mistake the hold for its own restriction. Unwidened holds unmount on departure; targeted background mounts retain their admitted tabs. */
export function releaseStartupTerminalTabHold(
  hold: { current: StartupTerminalTabHold | null },
  restrictions: Map<string, ReadonlySet<string>>,
  mountedWorktreeIds: Set<string>,
  nextHeldWorktreeId: string | null
): void {
  const held = hold.current
  if (!held || held.worktreeId === nextHeldWorktreeId) {
    return
  }
  hold.current = null
  if (restrictions.get(held.worktreeId)?.size === 0) {
    restrictions.delete(held.worktreeId)
    mountedWorktreeIds.delete(held.worktreeId)
  }
}

/** After pruning, hold terminal panes until startup publishes PTY ownership; no deferral entry prevents reveal/idle admission. Targeted mounts may widen it, while fully mounted worktrees are never narrowed. */
export function holdTerminalTabsForStartup(
  hold: { current: StartupTerminalTabHold | null },
  restrictions: Map<string, ReadonlySet<string>>,
  mountedWorktreeIds: Set<string>,
  worktreeId: string,
  tabIds: readonly string[]
): void {
  applyBackgroundMountTabRestriction(restrictions, mountedWorktreeIds, worktreeId, [])
  mountedWorktreeIds.add(worktreeId)
  const heldTabIds = collectDeferredMountTabIds(restrictions.get(worktreeId) ?? null, tabIds)
  const previous = hold.current
  // Preserve unchanged set identity for the memoized surface prop.
  if (
    previous?.worktreeId === worktreeId &&
    previous.heldTabIds.size === heldTabIds.size &&
    Array.from(heldTabIds).every((tabId) => previous.heldTabIds.has(tabId))
  ) {
    return
  }
  hold.current = { worktreeId, heldTabIds }
}

export function selectParkedEquivalentMountTabIds(
  activationDeferredMountTabIds: ReadonlySet<string> | undefined,
  hold: StartupTerminalTabHold | null,
  worktreeId: string
): ReadonlySet<string> | null {
  return activationDeferredMountTabIds ?? (hold?.worktreeId === worktreeId ? hold.heldTabIds : null)
}
