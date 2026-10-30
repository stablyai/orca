import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status'

// Mirrored handles arrive after tabs; unknown is not dead or recovery duplicates host agents (codex active-writer errors). Full inventory speaks for all worktrees by omission; scoped frames never answer for background workspaces.

type ParkedMirrorWaiter = { environmentId: string; worktreeId: string; run: () => void }

const hydratedGenerationByEnvironment = new Map<string, number>()
const hydratedGenerationByWorktree = new Map<string, number>()
const parkedWaitersByWorktree = new Map<string, ParkedMirrorWaiter>()
export const MAX_PARKED_HOST_SESSION_MIRROR_WAITERS = 512

function worktreeKey(environmentId: string, worktreeId: string): string {
  return `${environmentId}\0${worktreeId}`
}

/** Host restart advances generation; previous PTY verdicts no longer apply. */
function isCurrentGeneration(environmentId: string, generation: number | undefined): boolean {
  return (
    generation !== undefined &&
    generation === getRuntimeEnvironmentConnectionGeneration(environmentId)
  )
}

export function hasHostSessionMirrorHydrated(environmentId: string, worktreeId: string): boolean {
  return (
    isCurrentGeneration(environmentId, hydratedGenerationByEnvironment.get(environmentId)) ||
    isCurrentGeneration(
      environmentId,
      hydratedGenerationByWorktree.get(worktreeKey(environmentId, worktreeId))
    )
  )
}

function drainParkedWaiters(matches: (waiter: ParkedMirrorWaiter) => boolean): void {
  const dueKeys: string[] = []
  for (const [key, waiter] of parkedWaitersByWorktree) {
    if (matches(waiter)) {
      dueKeys.push(key)
    }
  }
  // Drain a snapshot: re-parked waiters belong to the next hydration.
  for (const key of dueKeys) {
    const waiter = parkedWaitersByWorktree.get(key)
    if (waiter) {
      parkedWaitersByWorktree.delete(key)
      try {
        waiter.run()
      } catch (error) {
        // Unrelated waiters run inside frame apply; contain one replay’s throw so it cannot strand siblings or escape into apply.
        console.warn('[host-session-mirror-hydration] parked replay failed:', error)
      }
    }
  }
}

/** Settle all only after full inventory commits. Waiters drain synchronously, so earlier settlement reads stale state; failures are unverifiable and prove no exit. */
export function markHostSessionMirrorHydrated(environmentId: string): void {
  hydratedGenerationByEnvironment.set(
    environmentId,
    getRuntimeEnvironmentConnectionGeneration(environmentId)
  )
  drainParkedWaiters((waiter) => waiter.environmentId === environmentId)
}

/** Settle only this worktree after its scoped frame commits; other worktree waiters stay parked. */
export function markHostSessionMirrorWorktreeHydrated(
  environmentId: string,
  worktreeId: string
): void {
  hydratedGenerationByWorktree.set(
    worktreeKey(environmentId, worktreeId),
    getRuntimeEnvironmentConnectionGeneration(environmentId)
  )
  drainParkedWaiters(
    (waiter) => waiter.environmentId === environmentId && waiter.worktreeId === worktreeId
  )
}

/** Reset verdicts, not owed recovery. Re-pair/effect restarts preserve waiters; removed environments retain at most one inert waiter/worktree because they never settle again. */
export function clearHostSessionMirrorHydration(environmentId: string): void {
  hydratedGenerationByEnvironment.delete(environmentId)
  const prefix = `${environmentId}\0`
  for (const key of hydratedGenerationByWorktree.keys()) {
    if (key.startsWith(prefix)) {
      hydratedGenerationByWorktree.delete(key)
    }
  }
}

export function parkUntilHostSessionMirrorHydrates(
  environmentId: string,
  worktreeId: string,
  run: () => void
): void {
  const key = worktreeKey(environmentId, worktreeId)
  parkedWaitersByWorktree.delete(key)
  parkedWaitersByWorktree.set(key, {
    environmentId,
    worktreeId,
    run
  })
  while (parkedWaitersByWorktree.size > MAX_PARKED_HOST_SESSION_MIRROR_WAITERS) {
    const oldest = parkedWaitersByWorktree.keys().next()
    if (oldest.done || oldest.value === key) {
      break
    }
    parkedWaitersByWorktree.delete(oldest.value)
  }
}

export function getParkedHostSessionMirrorWaiterCountForTests(): number {
  return parkedWaitersByWorktree.size
}

export function resetHostSessionMirrorHydrationForTests(): void {
  hydratedGenerationByEnvironment.clear()
  hydratedGenerationByWorktree.clear()
  parkedWaitersByWorktree.clear()
}
