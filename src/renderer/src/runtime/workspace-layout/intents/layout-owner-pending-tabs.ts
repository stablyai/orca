// Defer select/focus/reveal/cleanup for layout-owner opens/closes until main’s answering frame arrives.

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
const byEntity = new Map<string, Map<string, Set<string>>>()
let revision = 0

function forgetPendingTab(tabId: string, entry: PendingTab): void {
  pending.delete(tabId)
  revision++
  const workspaces = byEntity.get(entry.entityId)
  const tabs = workspaces?.get(entry.worktreeId)
  tabs?.delete(tabId)
  if (tabs?.size === 0) {
    workspaces?.delete(entry.worktreeId)
  }
  if (workspaces?.size === 0) {
    byEntity.delete(entry.entityId)
  }
}

/** Marks a tab as asked for; the returned settle runs its waiters once, with main's outcome. */
export function beginPendingTab(
  tabId: string,
  worktreeId: string,
  entityId: string,
  ask: PendingAsk
): (outcome: Outcome) => void {
  const entry: PendingTab = { worktreeId, entityId, ask, waiters: [] }
  const replaced = pending.get(tabId)
  if (replaced) {
    forgetPendingTab(tabId, replaced)
  }
  pending.set(tabId, entry)
  revision++
  const workspaces = byEntity.get(entityId) ?? new Map<string, Set<string>>()
  const tabs = workspaces.get(worktreeId) ?? new Set<string>()
  tabs.add(tabId)
  workspaces.set(worktreeId, tabs)
  byEntity.set(entityId, workspaces)
  return (outcome) => {
    if (pending.get(tabId) !== entry) {
      return
    }
    forgetPendingTab(tabId, entry)
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
export function hasPendingEntityTab(worktreeId: string | null, entityId: string): boolean {
  const workspaces = byEntity.get(entityId)
  return worktreeId === null
    ? Boolean(workspaces?.size)
    : Boolean(workspaces?.get(worktreeId)?.size)
}

/** Snapshot once for a batch that tests many content records. */
export function pendingEditorEntityIds(): ReadonlySet<string> {
  return new Set(byEntity.keys())
}

/** Runs `run` once every pending tab showing this entity is answered; at once when none is. */
export function afterPendingEntityTabs(
  worktreeId: string | null,
  entityId: string,
  run: () => void
): void {
  const workspaces = byEntity.get(entityId)
  const tabIds =
    worktreeId === null
      ? [...(workspaces?.values() ?? [])].flatMap((tabs) => [...tabs])
      : [...(workspaces?.get(worktreeId) ?? [])]
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
  revision++
  byEntity.clear()
}

/** Deletion retires outstanding placement requests before their late answers can recreate a view. */
export function retirePendingWorkspaceTabs(
  workspaceIds: ReadonlySet<string>,
  entityIds: ReadonlySet<string>
): void {
  for (const [id, entry] of pending) {
    if (workspaceIds.has(entry.worktreeId) || entityIds.has(entry.entityId)) {
      forgetPendingTab(id, entry)
      queueMicrotask(() => {
        for (const waiter of entry.waiters) {
          waiter(null)
        }
      })
    }
  }
}

export function pendingTabRevision(): number {
  return revision
}

export function pendingEntityWorkspaceIds(entityId: string): Iterable<string> {
  return byEntity.get(entityId)?.keys() ?? []
}

/** A dismissed creation menu must not seed over a surface still awaiting its owner frame. */
export function afterPendingWorkspaceTabs(worktreeId: string, run: () => void): void {
  afterPendingTabs(
    [...pending]
      .filter(([, entry]) => entry.worktreeId === worktreeId && entry.ask.kind === 'open')
      .map(([id]) => id),
    run
  )
}
