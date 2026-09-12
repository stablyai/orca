import { waitForPromiseWithSignal } from './abort-signal-reason'

export type TransportPublicationSettlement = { ok: true } | { ok: false; error: Error }

/** Local write completion only; downstream consumption requires separate proof. */
export class TransportPublicationDrain {
  private pending = 0
  protected failure: Error | undefined
  private readonly observers = new Set<() => void>()

  constructor(
    private readonly assertTransport: () => void,
    private readonly onFailure: (error: Error) => void = () => {}
  ) {
    this.assertCurrent()
  }

  trackWrite(): (result: TransportPublicationSettlement) => void {
    this.pending++
    let settled = false
    return (result) => {
      if (settled) {
        return
      }
      settled = true
      this.pending--
      if (!result.ok) {
        this.fail(result.error)
      }
      this.changed()
    }
  }

  fail(error: Error): void {
    if (this.failure) {
      return
    }
    this.failure = error
    this.changed()
    this.onFailure(error)
  }

  assertDrained(): void {
    this.assertCurrent()
    if (this.pending !== 0) {
      throw new Error('transport_publication_not_drained')
    }
  }

  async drain(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    while (this.pending !== 0) {
      this.assertCurrent()
      const changed = Promise.withResolvers<void>()
      this.observers.add(changed.resolve)
      try {
        await waitForPromiseWithSignal(changed.promise, signal)
      } finally {
        this.observers.delete(changed.resolve)
      }
    }
    signal.throwIfAborted()
    this.assertDrained()
  }

  assertCurrent(): void {
    if (this.failure) {
      throw this.failure
    }
    try {
      this.assertTransport()
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
      throw this.failure
    }
  }

  private changed(): void {
    for (const notify of this.observers) {
      notify()
    }
  }
}
