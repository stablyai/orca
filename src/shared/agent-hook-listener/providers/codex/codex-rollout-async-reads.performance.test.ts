import { expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'
import { RolloutReadBatch, rolloutFileSizeAsync } from './codex-rollout-async-reads'

const fs = vi.hoisted(() => ({ stats: 0, stalled: [] as (() => void)[] }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    stat: async () => {
      fs.stats++
      await new Promise<void>((resolve) => fs.stalled.push(resolve))
      return { size: 7 }
    }
  }
})

it.each([100, 1000])(
  'releases %s abandoned waiters while every read slot is stalled',
  async (waiters) => {
    fs.stats = 0
    const stalled = [0, 1, 2].map(() => rolloutFileSizeAsync('/stalled', new RolloutReadBatch()))
    let live = true
    const abandoned = Array.from({ length: waiters }, () =>
      rolloutFileSizeAsync('/abandoned', new RolloutReadBatch(() => live))
    )
    live = false
    const survivor = rolloutFileSizeAsync('/survivor', new RolloutReadBatch())

    await expect(Promise.all(abandoned)).resolves.toEqual(Array(waiters).fill(null))
    expect(fs.stats).toBe(3)

    for (const resume of fs.stalled.splice(0)) {
      resume()
    }
    await Promise.all(stalled)
    await vi.waitFor(() => expect(fs.stats).toBe(4))
    fs.stalled.splice(0)[0]()
    await expect(survivor).resolves.toBe(7)
  }
)
