import { afterEach, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'
import { RolloutReadBatch, rolloutFileSizeAsync } from './codex-rollout-async-reads'
import { AgentTranscriptPollScheduler } from '../../transcripts/agent-transcript-poll-scheduler'

const fs = vi.hoisted(() => {
  const stalled: (() => void)[] = []
  return { stats: 0, stalled }
})

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

function stallEveryReadSlot(): Promise<unknown>[] {
  fs.stats = 0
  return [0, 1, 2].map(() => rolloutFileSizeAsync('/stalled', new RolloutReadBatch()))
}

async function drain(reads: Promise<unknown>[]): Promise<void> {
  while (fs.stalled.length > 0) {
    for (const resume of fs.stalled.splice(0)) {
      resume()
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  await Promise.all(reads)
}

afterEach(() => {
  vi.useRealTimers()
})

it.each([100, 1000])(
  'settles %s queued polls a teardown abandons while every read slot is stalled',
  async (panes) => {
    const stalled = stallEveryReadSlot()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    let live = true
    const settled: (number | null)[] = []
    const scheduler = new AgentTranscriptPollScheduler<string>(1000, (key) =>
      rolloutFileSizeAsync(key, new RolloutReadBatch(() => live)).then((size) => {
        settled.push(size)
      })
    )
    for (let index = 0; index < panes; index++) {
      scheduler.schedule(`pane-${index}`, `pane-${index}`)
    }
    await vi.advanceTimersByTimeAsync(1000)
    expect(settled).toHaveLength(0)

    live = false
    scheduler.clearAll()
    await vi.advanceTimersByTimeAsync(0)

    expect(settled).toEqual(Array(panes).fill(null))
    expect(fs.stats).toBe(3)
    vi.useRealTimers()
    await drain(stalled)
  }
)

it.each([100, 1000])(
  'admits %s live waiters behind stalled slots with linear liveness checks',
  async (waiters) => {
    const stalled = stallEveryReadSlot()
    let checks = 0
    const queued = Array.from({ length: waiters }, () =>
      rolloutFileSizeAsync(
        '/queued',
        new RolloutReadBatch(() => {
          checks++
          return true
        })
      )
    )
    expect(checks).toBeLessThan(3 * waiters)
    expect(fs.stats).toBe(3)
    await drain([...stalled, ...queued])
    await expect(queued[waiters - 1]).resolves.toBe(7)
  }
)

it.each([100, 1000])(
  'prunes the queue once when %s polls retire one by one behind stalled slots',
  async (panes) => {
    const stalled = stallEveryReadSlot()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const retired = new Set<string>()
    let checks = 0
    const scheduler = new AgentTranscriptPollScheduler<string>(1000, async (key) => {
      await rolloutFileSizeAsync(
        key,
        new RolloutReadBatch(() => {
          checks++
          return !retired.has(key)
        })
      )
    })
    for (let index = 0; index < 2 * panes; index++) {
      scheduler.schedule(`pane-${index}`, `pane-${index}`)
    }
    await vi.advanceTimersByTimeAsync(1000)

    checks = 0
    for (let index = 0; index < panes; index++) {
      retired.add(`pane-${index}`)
      scheduler.clear(`pane-${index}`)
    }
    await vi.advanceTimersByTimeAsync(0)

    expect(checks).toBe(2 * panes)
    vi.useRealTimers()
    await drain(stalled)
  }
)
