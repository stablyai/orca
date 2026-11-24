export type LatestRemoteBrowserInput<T> = {
  push: (value: T) => void
  dispose: () => void
}

type LatestLane = {
  seal: () => void
  clear: () => void
}

/**
 * The one ordered lane for everything that acts on a streamed page, in the order the user did it.
 * Latest-wins input (hover, wheel) merges while it waits but takes one turn per send, so a
 * click or key never waits for movement to stop and never overtakes movement made before it.
 */
export class RemoteBrowserInputQueue {
  private tail: Promise<unknown> = Promise.resolve()
  private readonly lanes = new Set<LatestLane>()

  enqueue(operation: () => Promise<void>): Promise<void> {
    this.sealLanes(null)
    return this.append(operation)
  }

  /** Abandons queued work after a stream reset; operations already running finish on their own. */
  reset(): void {
    this.tail = Promise.resolve()
  }

  /** Drops input not yet sent, e.g. when the stream it was aimed at closes. */
  clearLatest(): void {
    for (const lane of this.lanes) {
      lane.clear()
    }
  }

  latest<T>({
    merge,
    send,
    perFrame = false
  }: {
    merge: (pending: T | null, next: T) => T
    send: (value: T) => Promise<void>
    /** Batches to one turn per animation frame (wheel); otherwise a turn is queued at once (hover). */
    perFrame?: boolean
  }): LatestRemoteBrowserInput<T> {
    // Each turn owns a slot; the open one still absorbs newer input until it is sent or sealed.
    type Slot = { value: T; queued: boolean; dropped: boolean }
    let open: Slot | null = null
    const unsent = new Set<Slot>()
    let frame: number | null = null
    const appendTurn = (slot: Slot): void => {
      if (slot.queued) {
        return
      }
      slot.queued = true
      void this.append(async () => {
        unsent.delete(slot)
        if (open === slot) {
          open = null
        }
        if (!slot.dropped) {
          await send(slot.value)
        }
      })
    }
    const flushFrame = (): void => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame)
        frame = null
      }
      if (open) {
        appendTurn(open)
      }
    }
    const lane: LatestLane = {
      seal: () => {
        flushFrame()
        open = null
      },
      clear: () => {
        if (frame !== null) {
          window.cancelAnimationFrame(frame)
          frame = null
        }
        for (const slot of unsent) {
          slot.dropped = true
        }
        unsent.clear()
        open = null
      }
    }
    this.lanes.add(lane)
    return {
      push: (value) => {
        if (open) {
          open.value = merge(open.value, value)
          return
        }
        // A new turn is new user input too: other lanes' input made before it stays ahead.
        this.sealLanes(lane)
        const slot: Slot = { value: merge(null, value), queued: false, dropped: false }
        open = slot
        unsent.add(slot)
        if (!perFrame) {
          appendTurn(slot)
        } else {
          frame = window.requestAnimationFrame(flushFrame)
        }
      },
      dispose: () => {
        lane.clear()
        this.lanes.delete(lane)
      }
    }
  }

  // Latest-wins input made so far stays ahead of what comes next; input made later goes behind it.
  private sealLanes(except: LatestLane | null): void {
    for (const lane of this.lanes) {
      if (lane !== except) {
        lane.seal()
      }
    }
  }

  private append(operation: () => Promise<void>): Promise<void> {
    const next = this.tail.catch(() => {}).then(operation)
    this.tail = next.catch(() => {})
    return next
  }
}
