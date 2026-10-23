// Tabs this window asked main to open or close in a layout-owner build, until the frame holding
// main's answer is in. An action on such a tab (select, focus, reveal, clean up) waits for it here.

/** The tab main's frame shows (its own id for a repeat open), or null when main refused. */
type Outcome = string | null

/** An open, with the group it asked for, or a close; `cleansFile`: a closeFile waits on it. */
type PendingAsk = { kind: 'open'; groupId?: string } | { kind: 'close'; cleansFile?: true }

type PendingTab = {
  worktreeId: string
  entityId: string
  ask: PendingAsk
  waiters: ((outcome: Outcome) => void)[]
}

const pending = new Map<string, PendingTab>()

/** Marks a tab as asked for; the returned settle runs its waiters once, with main's outcome. */
export function beginPendingTab(
  tabId: string,
  worktreeId: string,
  entityId: string,
  ask: PendingAsk
): (outcome: Outcome) => void {
  const entry: PendingTab = { worktreeId, entityId, ask, waiters: [] }
  pending.set(tabId, entry)
  return (outcome) => {
    if (pending.get(tabId) !== entry) {
      return
    }
    pending.delete(tabId)
    for (const run of entry.waiters) {
      try {
        run(outcome)
      } catch (error) {
        console.warn('[layout-owner] pending tab waiter threw:', error)
      }
    }
  }
}

/** Runs `run` once main answered for this tab; at once with its own id when nothing is pending. */
export function afterPendingTab(tabId: string, run: (outcome: Outcome) => void): void {
  const entry = pending.get(tabId)
  if (entry) {
    entry.waiters.push(run)
  } else {
    run(tabId)
  }
}

export function isPendingTab(tabId: string): boolean {
  return pending.has(tabId)
}

/** The group a pending open asked for. */
export function pendingTabGroupId(tabId: string): string | undefined {
  const ask = pending.get(tabId)?.ask
  return ask?.kind === 'open' ? ask.groupId : undefined
}

/** Whether main has yet to answer this tab's close: a repeat close joins it, sending nothing. */
export function isTabClosePending(tabId: string): boolean {
  return pending.get(tabId)?.ask.kind === 'close'
}

/** Notes that a closeFile's cleanup waits on this tab's pending close. */
export function markPendingCloseCleansFile(tabId: string): void {
  const ask = pending.get(tabId)?.ask
  if (ask?.kind === 'close') {
    ask.cleansFile = true
  }
}

/** Whether a closeFile's cleanup already waits on this tab's pending close. */
export function pendingCloseCleansFile(tabId: string): boolean {
  const ask = pending.get(tabId)?.ask
  return ask?.kind === 'close' && ask.cleansFile === true
}

/** Whether a tab showing this entity is still being opened or closed. */
export function hasPendingEntityTab(worktreeId: string, entityId: string): boolean {
  return [...pending.values()].some(
    (entry) => entry.worktreeId === worktreeId && entry.entityId === entityId
  )
}

/** Runs `run` once every pending tab showing this entity is answered; at once when none is. */
export function afterPendingEntityTabs(
  worktreeId: string,
  entityId: string,
  run: () => void
): void {
  const tabIds = [...pending]
    .filter(([, entry]) => entry.worktreeId === worktreeId && entry.entityId === entityId)
    .map(([tabId]) => tabId)
  afterPendingTabs(tabIds, () => run())
}

/** Runs `run` once each of these tabs is answered, with every outcome in order. */
export function afterPendingTabs(
  tabIds: readonly string[],
  run: (outcomes: Outcome[]) => void
): void {
  const outcomes: Outcome[] = []
  let left = tabIds.length
  if (left === 0) {
    run(outcomes)
    return
  }
  tabIds.forEach((tabId, index) =>
    afterPendingTab(tabId, (outcome) => {
      outcomes[index] = outcome
      left -= 1
      if (left === 0) {
        run(outcomes)
      }
    })
  )
}

export function _resetPendingTabsForTests(): void {
  pending.clear()
}
