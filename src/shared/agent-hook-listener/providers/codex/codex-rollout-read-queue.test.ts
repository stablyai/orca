import type * as FsPromises from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'

const stalled: (() => void)[] = []
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  stat: () => new Promise((resolve) => stalled.push(() => resolve({ size: 1, isFile: () => true })))
}))

const { RolloutReadBatch, rolloutFileSizeAsync } = await import('./codex-rollout-async-reads')

describe('rollout read slots', () => {
  afterEach(() => {
    stalled.splice(0).forEach((finish) => finish())
  })

  it("settles a retired owner's queued read while every slot is stalled", async () => {
    const live = new RolloutReadBatch()
    for (let i = 0; i < 3; i += 1) {
      void rolloutFileSizeAsync(`/stalled-${i}`, live)
    }
    let wanted = true
    const retired = rolloutFileSizeAsync('/retired', new RolloutReadBatch(() => wanted))
    wanted = false
    // A later live read touching the queue settles the retired one; the stalled slots stay held.
    void rolloutFileSizeAsync('/later', live)
    await expect(retired).resolves.toBeNull()
    expect(stalled).toHaveLength(3)

    stalled.shift()?.()
    await vi.waitFor(() => expect(stalled).toHaveLength(3))
  })
})
