/** How long a restored pane waits for the startup status snapshot before connecting anyway. */
export const AGENT_STATUS_STARTUP_SNAPSHOT_WAIT_MS = 5_000

type IdleGate = { phase: 'idle' }
type SettledGate = { phase: 'settled' }
type PendingGate = {
  phase: 'pending'
  epoch: number
  promise: Promise<void>
  resolve: () => void
  /**
   * Null until this snapshot has been sorted. After that, only these pane keys
   * still need a replay. A ready pane is not held for an unrelated key.
   */
  heldPaneKeys: Set<string> | null
  listeners: Set<() => void>
}

let epoch = 0
let gate: IdleGate | SettledGate | PendingGate = { phase: 'idle' }
let replayHoldEpoch: number | null = null
let replayHoldOwner: object | null = null

/**
 * Keeps the startup gate closed while a snapshot entry is waiting to be replayed.
 * `owner` is the queue that armed the hold, so a disposed bridge cannot settle a newer one.
 */
function notifyStartupSnapshotWaiters(): void {
  if (gate.phase !== 'pending') {
    return
  }
  const listeners: (() => void)[] = []
  for (const listener of gate.listeners) {
    listeners.push(listener)
  }
  for (const listener of listeners) {
    listener()
  }
}

function noteHeldStartupSnapshotPanes(armedEpoch: number, paneKeys: readonly string[]): void {
  if (gate.phase !== 'pending' || gate.epoch !== armedEpoch) {
    return
  }
  gate.heldPaneKeys = new Set(paneKeys)
  notifyStartupSnapshotWaiters()
}

function replayPaneKeysFromOwner(owner: object): string[] | null {
  if (!Array.isArray(owner)) {
    return null
  }
  const keys: string[] = []
  for (const event of owner) {
    if (
      typeof event === 'object' &&
      event !== null &&
      'replay' in event &&
      event.replay === true &&
      'data' in event &&
      typeof event.data === 'object' &&
      event.data !== null &&
      'paneKey' in event.data &&
      typeof event.data.paneKey === 'string'
    ) {
      keys.push(event.data.paneKey)
    }
  }
  return keys
}

export function holdAgentStatusStartupSnapshotForReplay(
  armedEpoch: number,
  owner: object,
  paneKeys?: readonly string[]
): void {
  replayHoldEpoch = armedEpoch
  replayHoldOwner = owner
  const keys = paneKeys ?? replayPaneKeysFromOwner(owner)
  if (keys) {
    noteHeldStartupSnapshotPanes(armedEpoch, keys)
  }
}

/**
 * Settles a held arm once its replay entries are gone. Returns true while that hold exists,
 * including the turn it settles. A different owner leaves the hold untouched.
 */
export function releaseAgentStatusStartupSnapshotReplayHold(
  replayStillQueued: boolean,
  owner?: object,
  paneKeys?: readonly string[]
): boolean {
  if (replayHoldEpoch === null) {
    return false
  }
  if (owner !== undefined && replayHoldOwner !== owner) {
    return false
  }
  if (replayStillQueued) {
    const keys = paneKeys ?? (owner ? replayPaneKeysFromOwner(owner) : null)
    if (keys) {
      noteHeldStartupSnapshotPanes(replayHoldEpoch, keys)
    }
    return true
  }
  const held = replayHoldEpoch
  replayHoldEpoch = null
  replayHoldOwner = null
  settleAgentStatusStartupSnapshot(held)
  return true
}

/** Opens one in-flight startup snapshot. A second arm while one is open returns the same epoch. */
export function armAgentStatusStartupSnapshot(): number {
  if (gate.phase === 'pending') {
    return gate.epoch
  }
  epoch += 1
  const armed = epoch
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  gate = { phase: 'pending', epoch: armed, promise, resolve, heldPaneKeys: null, listeners: new Set() }
  return armed
}

/** Releases waiters for this arm only. A newer arm or a reset ignores the stale epoch. */
export function settleAgentStatusStartupSnapshot(armedEpoch: number): void {
  if (gate.phase === 'pending' && gate.epoch === armedEpoch) {
    gate.resolve()
    gate = { phase: 'settled' }
  }
}

/** Drops an in-flight snapshot when the ready window ends, and wakes anyone still waiting. */
export function resetAgentStatusStartupSnapshotGate(): void {
  replayHoldEpoch = null
  replayHoldOwner = null
  epoch += 1
  if (gate.phase === 'pending') {
    gate.resolve()
  }
  gate = { phase: 'idle' }
}

/**
 * Resolves immediately when no startup snapshot is in flight. Otherwise waits until that
 * snapshot is applied or abandoned, or until `timeoutMs` elapses.
 * A pane key resolves once that pane is no longer in the replay hold, even if another
 * snapshot row is still unroutable.
 */
export function waitForAgentStatusStartupSnapshot(
  timeoutMs = AGENT_STATUS_STARTUP_SNAPSHOT_WAIT_MS,
  paneKey?: string
): Promise<void> {
  if (gate.phase !== 'pending') {
    return Promise.resolve()
  }
  const pending = gate
  const paneReleased = (): boolean => {
    if (gate.phase !== 'pending' || gate.epoch !== pending.epoch) {
      return true
    }
    // No pane identity, or the snapshot has not been sorted yet: keep waiting.
    if (!paneKey || pending.heldPaneKeys === null) {
      return false
    }
    return !pending.heldPaneKeys.has(paneKey)
  }
  if (paneReleased()) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    let finished = false
    const finish = (): void => {
      if (finished) {
        return
      }
      finished = true
      clearTimeout(timer)
      pending.listeners.delete(listener)
      resolve()
    }
    const listener = (): void => {
      if (paneReleased()) {
        finish()
      }
    }
    const timer = setTimeout(finish, timeoutMs)
    pending.listeners.add(listener)
    void pending.promise.then(finish)
  })
}
