import { monotonicNow, type Settled } from '../../../concurrency/deadline-settle-notifier'

// Why: an open stalled by an on-access scan holds a libuv thread (4 by default); leave one free for other file work.
const MAX_CONCURRENT_ROLLOUT_READS = 3
const MAX_QUEUED_ROLLOUT_READS = 4096
const ROLLOUT_READ_TIMEOUT_MS = 20_000

const nativeReads = new Set<{ stalledAt: number }>()
const parkedPolls = new Set<() => void>()
let reportedStall = false

function allReadSlotsStalled(now: number): boolean {
  if (nativeReads.size < MAX_CONCURRENT_ROLLOUT_READS) {
    return false
  }
  for (const read of nativeReads) {
    if (read.stalledAt > now) {
      return false
    }
  }
  if (!reportedStall) {
    reportedStall = true
    console.warn('[agent-hooks] Transcript reads stalled')
  }
  return true
}

export function parkRolloutPollIfStalled(resume: () => void): (() => void) | undefined {
  if (!allReadSlotsStalled(monotonicNow())) {
    return undefined
  }
  parkedPolls.add(resume)
  return () => parkedPolls.delete(resume)
}

type RolloutReadWaiter = {
  previous?: RolloutReadWaiter
  next?: RolloutReadWaiter
  start: () => void
}

let firstWaiter: RolloutReadWaiter | undefined
let lastWaiter: RolloutReadWaiter | undefined
let queuedReads = 0

function enqueueWaiter(waiter: RolloutReadWaiter): void {
  waiter.previous = lastWaiter
  if (lastWaiter) {
    lastWaiter.next = waiter
  } else {
    firstWaiter = waiter
  }
  lastWaiter = waiter
  queuedReads++
}

function unlinkWaiter(waiter: RolloutReadWaiter): void {
  if (waiter.previous) {
    waiter.previous.next = waiter.next
  } else {
    firstWaiter = waiter.next
  }
  if (waiter.next) {
    waiter.next.previous = waiter.previous
  } else {
    lastWaiter = waiter.previous
  }
  waiter.previous = undefined
  waiter.next = undefined
  queuedReads--
}

// Why: buffers live until their poll or hook applies them; cap what all pending batches hold so many queued panes cannot pile up megabytes each.
const MAX_HELD_ROLLOUT_BYTES = 16 * 1024 * 1024
// Why: one pane stalled on a slow open must not hold the whole budget and stall every other pane.
const MAX_BATCH_HELD_ROLLOUT_BYTES = 4 * 1024 * 1024
let heldRolloutBytes = 0
/** One poll's or hook's reads: whether they are still wanted, and the buffer bytes they hold until released. */
export class RolloutReadBatch {
  readonly budget = { held: 0, retained: 0 }
  private released = false

  constructor(
    private readonly isWanted: () => boolean = () => true,
    readonly signal?: AbortSignal,
    readonly expiresAt?: () => number
  ) {}

  wanted(): boolean {
    return !this.released && !this.signal?.aborted && this.isWanted()
  }

  /** Call once the batch is applied or dropped. */
  release(): void {
    this.released = true
    heldRolloutBytes -= this.budget.retained
    this.budget.held -= this.budget.retained
    this.budget.retained = 0
  }
}

export type RolloutRead = {
  wanted: () => boolean
  reserve: (bytes: number, lifetime: 'read' | 'batch') => boolean
}

export function withRolloutReadSlot<T>(
  run: (read: RolloutRead) => Promise<T>,
  batch: RolloutReadBatch,
  unwanted: T,
  releasePrefetchPath?: () => void
): Promise<T> {
  const now = monotonicNow()
  const delay = Math.min(ROLLOUT_READ_TIMEOUT_MS, (batch.expiresAt?.() ?? Infinity) - Date.now())
  if (
    delay <= 0 ||
    !batch.wanted() ||
    allReadSlotsStalled(now) ||
    queuedReads >= MAX_QUEUED_ROLLOUT_READS
  ) {
    releasePrefetchPath?.()
    return Promise.resolve(unwanted)
  }
  const deadline = now + delay
  // Why: a hung native continuation keeps its byte charges, but must drop the retired caller.
  const budget = batch.budget
  let request:
    | { batch: RolloutReadBatch; resolve: (value: T) => void; reject: (error: unknown) => void }
    | undefined
  const promise = new Promise<T>((resolve, reject) => {
    request = { batch, resolve, reject }
  })
  let waiter: RolloutReadWaiter | undefined
  let started = false
  const complete = (outcome: Settled<T>): void => {
    const caller = request
    if (!caller) {
      return
    }
    request = undefined
    clearTimeout(timer)
    caller.batch.signal?.removeEventListener('abort', abandon)
    if (waiter) {
      unlinkWaiter(waiter)
      waiter = undefined
    }
    if (!started) {
      releasePrefetchPath?.()
    }
    if (outcome.ok) {
      caller.resolve(outcome.value)
    } else {
      caller.reject(outcome.error)
    }
  }
  const abandon = (): void => {
    complete({ ok: true, value: unwanted })
    allReadSlotsStalled(monotonicNow())
  }
  const wanted = (): boolean => monotonicNow() < deadline && request?.batch.wanted() === true
  const start = (): void => {
    if (!wanted()) {
      abandon()
      return
    }
    if (waiter) {
      unlinkWaiter(waiter)
      waiter = undefined
    }
    // A short lease or a long queue wait can end a caller before its native operation stalls.
    const native = { stalledAt: monotonicNow() + ROLLOUT_READ_TIMEOUT_MS }
    started = true
    nativeReads.add(native)
    let held = 0
    let retained = 0
    const reserve: RolloutRead['reserve'] = (bytes, lifetime) => {
      if (
        budget.held + bytes > MAX_BATCH_HELD_ROLLOUT_BYTES ||
        heldRolloutBytes + bytes > MAX_HELD_ROLLOUT_BYTES
      ) {
        return false
      }
      budget.held += bytes
      heldRolloutBytes += bytes
      held += bytes
      if (lifetime === 'batch') {
        retained += bytes
      }
      return true
    }
    const finish = (outcome: Settled<T>): void => {
      allReadSlotsStalled(monotonicNow())
      const accepted = wanted()
      const keep = accepted && outcome.ok ? retained : 0
      budget.held -= held - keep
      heldRolloutBytes -= held - keep
      budget.retained += keep
      complete(accepted ? outcome : { ok: true, value: unwanted })
      // A caller may leave early. Only native settlement (including close) frees capacity.
      nativeReads.delete(native)
      releasePrefetchPath?.()
      reportedStall = false
      while (firstWaiter && nativeReads.size < MAX_CONCURRENT_ROLLOUT_READS) {
        firstWaiter.start()
      }
      if (parkedPolls.size > 0) {
        const ready = [...parkedPolls]
        parkedPolls.clear()
        for (const resume of ready) {
          resume()
        }
      }
    }
    void run({ wanted, reserve }).then(
      (value) => finish({ ok: true, value }),
      (error: unknown) => finish({ ok: false, error })
    )
  }
  const timer = setTimeout(abandon, Math.ceil(delay))
  timer.unref?.()
  batch.signal?.addEventListener('abort', abandon, { once: true })
  if (nativeReads.size < MAX_CONCURRENT_ROLLOUT_READS) {
    start()
  } else {
    waiter = { start }
    enqueueWaiter(waiter)
  }
  return promise
}
