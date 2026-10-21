import { expect, it } from 'vitest'
import { RelayDispatcher } from './dispatcher'
import type { PreparedRelayFrame, RelayClient } from './dispatcher-contract'
import type { SinkWriteSettlement } from './dispatcher-client-writer'

class FailedAdmissionDispatcher extends RelayDispatcher {
  attempts = 0

  wake(): void {
    this.notifyLegacyCapacityIfLow()
  }

  listeners(): number {
    return this.legacyCapacityListeners.size
  }

  protected override publishPreparedToClient(
    client: RelayClient,
    frame: PreparedRelayFrame,
    lane: 'interactive' | 'ordinary' | 'fixed-bulk' | 'bulk',
    onSettled: (result: SinkWriteSettlement) => void = () => {}
  ): boolean {
    this.attempts++
    if (this.attempts === 1) {
      return false
    }
    if (this.attempts === 2) {
      this.notifyLegacyCapacityIfLow()
      return false
    }
    if (this.attempts > 6) {
      throw new Error('Admission retry did not remain bounded')
    }
    return super.publishPreparedToClient(client, frame, lane, onSettled)
  }
}

it('preserves a capacity wake during a failed admission without needing another event', async () => {
  let writes = 0
  const dispatcher = new FailedAdmissionDispatcher(() => {
    writes++
    return true
  })
  try {
    const completion = dispatcher.notifyBulk('git.responseChunk', { streamId: 1, seq: 0 })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(dispatcher.attempts).toBe(1)
    dispatcher.wake()
    expect(dispatcher.attempts).toBe(3)
    await completion
    expect(writes).toBe(1)
    expect(dispatcher.listeners()).toBe(0)
  } finally {
    dispatcher.dispose()
  }
})
