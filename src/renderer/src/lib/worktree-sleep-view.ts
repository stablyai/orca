import { useSyncExternalStore } from 'react'

// Two facts the sleep UI shows, kept apart from the store so the follower can set them before any
// render: which workspaces are going to sleep right now (Sleep chosen, not yet ended), and which
// one stays on screen read-only after its Sleep ("view-only": never wakes, only shows the copy).
const goingToSleep = new Set<string>()
const viewOnly = new Set<string>()
// Main is suspending the VM (past its last reopen check): Keep awake can no longer work.
const suspendCommitted = new Set<string>()
// "Keep awake" pressed while the sleep runs, possibly before main's started notice. Not shown.
const keptAwake = new Set<string>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of Array.from(listeners)) {
    listener()
  }
}

function change(set: Set<string>, worktreeId: string, present: boolean): boolean {
  if (set.has(worktreeId) === present) {
    return false
  }
  if (present) {
    set.add(worktreeId)
  } else {
    set.delete(worktreeId)
  }
  emit()
  return true
}

export function subscribeWorktreeSleepView(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function markWorktreeGoingToSleep(worktreeId: string): void {
  change(goingToSleep, worktreeId, true)
}

export function clearWorktreeGoingToSleep(worktreeId: string): void {
  change(goingToSleep, worktreeId, false)
}

export function isWorktreeGoingToSleep(worktreeId: string): boolean {
  return goingToSleep.has(worktreeId)
}

/** Keeps the just-slept active workspace on screen read-only. True when newly held. */
export function holdWorktreeSleepView(worktreeId: string): boolean {
  return change(viewOnly, worktreeId, true)
}

/** Ends view-only (the user left it, woke it, or the sleep failed). True when it was held. */
export function releaseWorktreeSleepView(worktreeId: string): boolean {
  return change(viewOnly, worktreeId, false)
}

export function isWorktreeSleepViewHeld(worktreeId: string | null): boolean {
  return worktreeId !== null && viewOnly.has(worktreeId)
}

export function markWorktreeSuspendCommitted(worktreeId: string): void {
  change(suspendCommitted, worktreeId, true)
}

export function clearWorktreeSuspendCommitted(worktreeId: string): void {
  change(suspendCommitted, worktreeId, false)
}

export function isWorktreeSuspendCommitted(worktreeId: string): boolean {
  return suspendCommitted.has(worktreeId)
}

export function useIsWorktreeSuspendCommitted(worktreeId: string | null): boolean {
  return useSyncExternalStore(subscribeWorktreeSleepView, () =>
    worktreeId === null ? false : suspendCommitted.has(worktreeId)
  )
}

export function markWorktreeKeptAwake(worktreeId: string): void {
  keptAwake.add(worktreeId)
}

export function clearWorktreeKeptAwake(worktreeId: string): void {
  keptAwake.delete(worktreeId)
}

export function isWorktreeKeptAwake(worktreeId: string): boolean {
  return keptAwake.has(worktreeId)
}

export function useIsWorktreeGoingToSleep(worktreeId: string | null): boolean {
  return useSyncExternalStore(subscribeWorktreeSleepView, () =>
    worktreeId === null ? false : goingToSleep.has(worktreeId)
  )
}

export function useIsWorktreeSleepViewHeld(worktreeId: string | null): boolean {
  return useSyncExternalStore(subscribeWorktreeSleepView, () => isWorktreeSleepViewHeld(worktreeId))
}

export function resetWorktreeSleepViewForTests(): void {
  goingToSleep.clear()
  viewOnly.clear()
  keptAwake.clear()
  suspendCommitted.clear()
  listeners.clear()
}
