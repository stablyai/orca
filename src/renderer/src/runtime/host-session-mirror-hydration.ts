import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status'

/**
 * Tells "the host reported no PTY" apart from "the host has not answered yet"
 * for mirrored `web-terminal-*` panes, whose PTY handle lands a round trip
 * after the tab. Reading that gap as pane death relaunched agents the host was
 * still running (codex `-32600 already has an active writer`).
 *
 * The two granularities are NOT interchangeable: a full inventory speaks for
 * every worktree because absence from it is itself a verdict, while a
 * single-worktree frame says nothing about a background workspace.
 */

type ParkedMirrorWaiter = { environmentId: string; worktreeId: string; run: () => void }

const hydratedGenerationByEnvironment = new Map<string, number>()
const hydratedGenerationByWorktree = new Map<string, number>()
const parkedWaitersByWorktree = new Map<string, ParkedMirrorWaiter>()

function worktreeKey(environmentId: string, worktreeId: string): string {
  return `${environmentId}\0${worktreeId}`
}

/** Why: a host restart bumps the connection generation, so a verdict from the
 *  previous connection says nothing about the PTYs of the new one. */
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
  // Why: drain from a snapshot — a replay can re-park itself, and that new
  // waiter belongs to the next hydration, not this one.
  for (const key of dueKeys) {
    const waiter = parkedWaitersByWorktree.get(key)
    if (waiter) {
      parkedWaitersByWorktree.delete(key)
      waiter.run()
    }
  }
}

/**
 * Settles the whole environment. Call only for a full inventory ALREADY applied
 * to the store — never for a failure, which is `unverifiable` and no evidence a
 * host-owned PTY exited. Waiters drain synchronously, so settling before the
 * patch lands re-runs recovery against state the frame has not written yet.
 */
export function markHostSessionMirrorHydrated(environmentId: string): void {
  hydratedGenerationByEnvironment.set(
    environmentId,
    getRuntimeEnvironmentConnectionGeneration(environmentId)
  )
  drainParkedWaiters((waiter) => waiter.environmentId === environmentId)
}

/** Settles one worktree, for a single-worktree frame already applied to the
 *  store. Never releases panes parked on this environment's other worktrees. */
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

/** Why: waiters survive this reset — a re-pair or effect restart replaces the
 *  verdict, it does not cancel the recovery the client still owes. A permanently
 *  removed environment therefore keeps its waiters: bounded at one per worktree,
 *  and inert, because nothing can settle an environment that never returns. */
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
  parkedWaitersByWorktree.set(worktreeKey(environmentId, worktreeId), {
    environmentId,
    worktreeId,
    run
  })
}

export function resetHostSessionMirrorHydrationForTests(): void {
  hydratedGenerationByEnvironment.clear()
  hydratedGenerationByWorktree.clear()
  parkedWaitersByWorktree.clear()
}
