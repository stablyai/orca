import {
  applyBackgroundMountTabRestriction,
  collectDeferredMountTabIds
} from './background-terminal-worktree-mount'

export type StartupTerminalTabHold = {
  worktreeId: string
  /** Tabs the hold keeps unmounted — parked-equivalent, so watchers own their side effects. */
  heldTabIds: ReadonlySet<string>
}

/**
 * Ends the hold unless `nextHeldWorktreeId` is still the held worktree. Must run before the
 * activation plan, which would otherwise read the hold as a plan it had installed.
 *
 * Why an unwidened hold unmounts: nothing but the surface was mounted under it, so a worktree
 * switched away from — or left for no workspace — mid-startup returns to the unmounted world
 * where parked watchers cover it. A hold a targeted background mount widened keeps that mount's
 * tabs, like any targeted restriction.
 */
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

/**
 * Keeps the worktree's terminal tabs unmounted while startup restoration is still publishing
 * PTY ownership, so the workspace surface can mount from the hydrated tab model without a pane
 * binding a PTY early. Runs after prune, so no prune pass can drop the hold before render.
 *
 * Why an empty admitted set and no deferral entry: reveal and idle admission act only on
 * worktrees with a deferral entry, so nothing admits a held tab until the startup gate opens
 * and the activation plan replaces the hold. A targeted background mount widens it to its
 * tabs, as it widens any restriction; a worktree already fully mounted is never narrowed.
 */
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
  // Why reuse: the set feeds a memoized surface prop, so an unchanged hold keeps its identity.
  if (
    previous?.worktreeId === worktreeId &&
    previous.heldTabIds.size === heldTabIds.size &&
    Array.from(heldTabIds).every((tabId) => previous.heldTabIds.has(tabId))
  ) {
    return
  }
  hold.current = { worktreeId, heldTabIds }
}

/** The watcher-coverage set for a mounted worktree: activation-deferred tabs, else held tabs. */
export function selectParkedEquivalentMountTabIds(
  activationDeferredMountTabIds: ReadonlySet<string> | undefined,
  hold: StartupTerminalTabHold | null,
  worktreeId: string
): ReadonlySet<string> | null {
  return activationDeferredMountTabIds ?? (hold?.worktreeId === worktreeId ? hold.heldTabIds : null)
}
