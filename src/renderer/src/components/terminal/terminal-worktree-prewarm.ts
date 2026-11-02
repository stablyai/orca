import type { TerminalTab } from '../../../../shared/terminal-tab-types'

/** Each stage is its own task so a slow pointer sweep never stacks mount, style/layout and WebGL into one long frame. */
export type TerminalPrewarmStage = 'mount' | 'layout' | 'warm'

/** Hover warms the row under the pointer; neighbor keeps the workspaces one keyboard step away warm. */
export type TerminalPrewarmClient = 'hover' | 'neighbor'

// Each client holds a small fixed budget (hover 1, neighbor 2), so at most three extra worktrees stay mounted.
const worktreeIdsByClient = new Map<TerminalPrewarmClient, readonly string[]>()
const listeners = new Set<() => void>()

export function setTerminalPrewarmWorktrees(
  client: TerminalPrewarmClient,
  worktreeIds: readonly string[]
): void {
  const current = worktreeIdsByClient.get(client) ?? []
  if (
    current.length === worktreeIds.length &&
    current.every((worktreeId, index) => worktreeId === worktreeIds[index])
  ) {
    return
  }
  worktreeIdsByClient.set(client, [...worktreeIds])
  for (const listener of listeners) {
    listener()
  }
}

/** Every prewarmed worktree with the clients holding it. */
export function getTerminalPrewarmWorktrees(): ReadonlyMap<
  string,
  ReadonlySet<TerminalPrewarmClient>
> {
  const clientsByWorktree = new Map<string, Set<TerminalPrewarmClient>>()
  for (const [client, worktreeIds] of worktreeIdsByClient) {
    for (const worktreeId of worktreeIds) {
      const clients = clientsByWorktree.get(worktreeId) ?? new Set<TerminalPrewarmClient>()
      clients.add(client)
      clientsByWorktree.set(worktreeId, clients)
    }
  }
  return clientsByWorktree
}

// Worktrees whose lease actually took (a tab plan admitted their visible terminal); only these skip parking.
let heldWorktreeIds: ReadonlySet<string> = new Set()

export function setHeldTerminalPrewarmWorktrees(worktreeIds: Iterable<string>): void {
  heldWorktreeIds = new Set(worktreeIds)
}

export function getHeldTerminalPrewarmWorktrees(): ReadonlySet<string> {
  return heldWorktreeIds
}

export function subscribeTerminalPrewarmWorktrees(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export type TerminalPrewarmTabMountPlan = {
  allowedTabIds: Set<string>
  deferredTabIds: Set<string>
}

/** Admit the revealable tabs plus already-live panes; restorable siblings stay parked-watched and every other tab stays unmounted. */
export function planTerminalPrewarmTabMount(args: {
  tabs: readonly TerminalTab[]
  revealTabIds: ReadonlySet<string>
  isTabLive: (tabId: string) => boolean
  isTabRestorable: (tab: TerminalTab) => boolean
  isTabSleeping: (tabId: string) => boolean
  /** Mounting reattaches the PTY, and a reattach to a lost session spawns a new one; admit only daemon-confirmed sessions. */
  isSessionConfirmedLive: (tab: TerminalTab) => boolean
}): TerminalPrewarmTabMountPlan | null {
  const allowedTabIds = new Set<string>()
  const deferredTabIds = new Set<string>()
  let admitsRevealTab = false
  for (const tab of args.tabs) {
    const live = args.isTabLive(tab.id)
    // Prewarm must never spawn a shell or wake an agent: only reattach PTYs a snapshot can restore.
    const restorable = !live && args.isTabRestorable(tab) && !args.isTabSleeping(tab.id)
    if (live || (restorable && args.revealTabIds.has(tab.id) && args.isSessionConfirmedLive(tab))) {
      allowedTabIds.add(tab.id)
      admitsRevealTab ||= args.revealTabIds.has(tab.id)
    } else if (restorable) {
      deferredTabIds.add(tab.id)
    }
  }
  return admitsRevealTab ? { allowedTabIds, deferredTabIds } : null
}

export type TerminalPrewarmNarrowing = {
  allowedTabIds: ReadonlySet<string>
  deferredTabIds: ReadonlySet<string>
}

/**
 * Hand a narrowed live mount back on lease release, but only while the lease still owns it: once
 * activation or another mount replaced the restriction, the deferred ids belong to that owner.
 */
export function undoTerminalPrewarmNarrowing(args: {
  restrictions: Map<string, ReadonlySet<string>>
  deferredMountTabIdsByWorktree: Map<string, ReadonlySet<string>>
  worktreeId: string
  narrowing: TerminalPrewarmNarrowing
  isActivated: boolean
}): void {
  const { restrictions, deferredMountTabIdsByWorktree, worktreeId, narrowing } = args
  if (args.isActivated || restrictions.get(worktreeId) !== narrowing.allowedTabIds) {
    return
  }
  restrictions.delete(worktreeId)
  const remaining = [...(deferredMountTabIdsByWorktree.get(worktreeId) ?? [])].filter(
    (tabId) => !narrowing.deferredTabIds.has(tabId)
  )
  if (remaining.length > 0) {
    deferredMountTabIdsByWorktree.set(worktreeId, new Set(remaining))
  } else {
    deferredMountTabIdsByWorktree.delete(worktreeId)
  }
}

/** A reattach reconnects every leaf of a tab; it is safe only when exactly these sessions were each confirmed live. */
export function areTabSessionsConfirmed(
  candidatePtyIds: readonly string[],
  confirmedPtyIds: ReadonlySet<string> | undefined
): boolean {
  return (
    confirmedPtyIds !== undefined &&
    candidatePtyIds.length > 0 &&
    new Set(candidatePtyIds).size === confirmedPtyIds.size &&
    candidatePtyIds.every((ptyId) => confirmedPtyIds.has(ptyId))
  )
}

/**
 * Ending a lease's measurement starts tab cold parking's cool-down, during which individually
 * parked siblings would remount; keep the narrowing until that cool-down has passed.
 */
export function createDeferredNarrowingUndo(args: {
  delayMs: number
  undo: (worktreeId: string, narrowing: TerminalPrewarmNarrowing) => void
  /** Milliseconds to wait again when a newer measurement or its cool-down still holds tab parking off. */
  remainingHoldMs: (worktreeId: string) => number | null
}) {
  const pending = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; narrowing: TerminalPrewarmNarrowing }
  >()
  const flush = (worktreeId: string): void => {
    const entry = pending.get(worktreeId)
    if (!entry) {
      return
    }
    clearTimeout(entry.timer)
    pending.delete(worktreeId)
    args.undo(worktreeId, entry.narrowing)
  }
  return {
    schedule(worktreeId: string, narrowing: TerminalPrewarmNarrowing): void {
      flush(worktreeId)
      const arm = (delayMs: number): void => {
        const timer = setTimeout(() => {
          const holdMs = args.remainingHoldMs(worktreeId)
          if (holdMs !== null && holdMs > 0) {
            arm(holdMs)
            return
          }
          pending.delete(worktreeId)
          args.undo(worktreeId, narrowing)
        }, delayMs)
        pending.set(worktreeId, { timer, narrowing })
      }
      arm(args.delayMs)
    },
    /** A new lease on the same worktree replaces the pending narrowing with its own. */
    flush,
    cancelAll(): void {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer)
      }
      pending.clear()
    }
  }
}
