// Why: an open stalled by an on-access scan holds a libuv thread (4 by default); leave one free for other file work.
const MAX_CONCURRENT_ROLLOUT_READS = 3
let rolloutReadsInFlight = 0
const MAX_QUEUED_ROLLOUT_READS = 4096

type RolloutReadWaiter = {
  previous?: RolloutReadWaiter
  next?: RolloutReadWaiter
  settle: (granted: boolean) => void
}

let firstWaiter: RolloutReadWaiter | undefined
let lastWaiter: RolloutReadWaiter | undefined
let queuedReads = 0

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
  private held = 0
  private released = false
  private activeReads = 0

  constructor(
    private readonly isWanted: () => boolean = () => true,
    readonly signal?: AbortSignal
  ) {}

  wanted(): boolean {
    return !this.released && !this.signal?.aborted && this.isWanted()
  }

  reserve(bytes: number): boolean {
    if (
      this.released ||
      this.held + bytes > MAX_BATCH_HELD_ROLLOUT_BYTES ||
      heldRolloutBytes + bytes > MAX_HELD_ROLLOUT_BYTES
    ) {
      return false
    }
    heldRolloutBytes += bytes
    this.held += bytes
    return true
  }

  /** Returns bytes a read already dropped, such as a parsed first-line buffer. */
  unreserve(bytes: number): void {
    const returned = Math.min(bytes, this.held)
    heldRolloutBytes -= returned
    this.held -= returned
  }

  startRead(): void {
    this.activeReads++
  }

  finishRead(): void {
    this.activeReads--
    if (this.released) {
      this.release()
    }
  }

  /** Call once the batch is applied or dropped. */
  release(): void {
    this.released = true
    if (this.activeReads === 0) {
      this.unreserve(this.held)
    }
  }
}

/** `wanted` is rechecked once a slot is granted, so work its caller abandoned while queued never touches the disk. */
export async function withRolloutReadSlot<T>(
  run: () => Promise<T>,
  batch: RolloutReadBatch,
  unwanted: T
): Promise<T> {
  if (!batch.wanted()) {
    return unwanted
  }
  if (rolloutReadsInFlight < MAX_CONCURRENT_ROLLOUT_READS) {
    rolloutReadsInFlight += 1
  } else {
    if (queuedReads >= MAX_QUEUED_ROLLOUT_READS) {
      return unwanted
    }
    const granted = await new Promise<boolean>((resolve) => {
      const waiter: RolloutReadWaiter = {
        previous: lastWaiter,
        settle: (granted) => {
          unlinkWaiter(waiter)
          batch.signal?.removeEventListener('abort', cancel)
          resolve(granted)
        }
      }
      const cancel = () => waiter.settle(false)
      if (lastWaiter) {
        lastWaiter.next = waiter
      } else {
        firstWaiter = waiter
      }
      lastWaiter = waiter
      queuedReads++
      batch.signal?.addEventListener('abort', cancel, { once: true })
    })
    if (!granted) {
      return unwanted
    }
  }
  batch.startRead()
  try {
    if (!batch.wanted()) {
      return unwanted
    }
    const result = await run()
    return batch.wanted() ? result : unwanted
  } finally {
    batch.finishRead()
    // Only the physical read's settlement hands its slot to the oldest waiter.
    if (firstWaiter) {
      firstWaiter.settle(true)
    } else {
      rolloutReadsInFlight -= 1
    }
  }
}
