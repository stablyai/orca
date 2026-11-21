import { afterEach, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'
import { RolloutReadBatch, rolloutFileSizeAsync } from './codex-rollout-async-reads'
import { AgentTranscriptPollScheduler } from '../../transcripts/agent-transcript-poll-scheduler'

const fs = vi.hoisted(() => {
  const stalled: (() => void)[] = []
  return { stats: 0, started: [] as string[], stalled }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    stat: async (path: string) => {
      fs.started.push(path)
      fs.stats++
      await new Promise<void>((resolve) => fs.stalled.push(resolve))
      return { size: 7 }
    }
  }
})

function stallEveryReadSlot(): Promise<unknown>[] {
  fs.stats = 0
  fs.started.length = 0
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
    const settled: (number | null)[] = []
    const scheduler = new AgentTranscriptPollScheduler<string>(1000, (key, _value, signal) =>
      rolloutFileSizeAsync(key, new RolloutReadBatch(undefined, signal)).then((size) => {
        settled.push(size)
      })
    )
    for (let index = 0; index < panes; index++) {
      scheduler.schedule(`pane-${index}`, `pane-${index}`)
    }
    await vi.advanceTimersByTimeAsync(1000)
    expect(settled).toHaveLength(0)

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
  'unlinks %s individually retired polls without checking survivors until a slot frees',
  async (panes) => {
    const stalled = stallEveryReadSlot()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const settled: string[] = []
    let checks = 0
    const scheduler = new AgentTranscriptPollScheduler<string>(1000, async (key, _, signal) => {
      const size = await rolloutFileSizeAsync(
        key,
        new RolloutReadBatch(() => {
          checks++
          return true
        }, signal)
      )
      if (size === null) {
        settled.push(key)
      }
    })
    const names = Array.from({ length: 2 * panes }, (_, index) => `pane-${index}`)
    for (const key of names) {
      scheduler.schedule(key, key)
    }
    await vi.advanceTimersByTimeAsync(1000)

    checks = 0
    for (let index = 0; index < names.length; index += 2) {
      scheduler.clear(names[index]!)
      await Promise.resolve()
    }
    await vi.advanceTimersByTimeAsync(0)

    expect(checks).toBe(0)
    expect(settled).toEqual(names.filter((_, index) => index % 2 === 0))
    expect(fs.started).toEqual(['/stalled', '/stalled', '/stalled'])
    vi.useRealTimers()
    await drain(stalled)
    expect(fs.started.slice(3)).toEqual(names.filter((_, index) => index % 2 === 1))
    scheduler.clearAll()
  }
)
