import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'
import {
  readJsonlCursorBytes,
  RolloutReadBatch,
  rolloutFileSizeAsync
} from './codex-rollout-async-reads'
import { AgentTranscriptPollScheduler } from '../../transcripts/agent-transcript-poll-scheduler'

// #43539 moved rollout reads off the event loop. Hung reads must also leave other panes able to progress.
const fs = vi.hoisted(() => {
  const stalled: (() => void)[] = []
  const cursors = new Map<string, { read: () => Promise<void>; close: () => Promise<void> }>()
  const started: string[] = []
  return { stats: 0, started, stalled, cursors }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    stat: async (path: string) => {
      if (fs.cursors.has(path)) {
        return { isFile: () => true, size: 1024 * 1024 }
      }
      fs.started.push(path)
      fs.stats++
      await new Promise<void>((resolve) => fs.stalled.push(resolve))
      return { size: 7 }
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const file = fs.cursors.get(args[0].toString())
      if (!file) {
        return actual.open(...args)
      }
      return {
        read: async (buffer: Buffer) => {
          await file.read()
          buffer.fill(0)
          return { bytesRead: buffer.length }
        },
        close: file.close
      }
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] })
})

afterEach(() => {
  fs.cursors.clear()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it.each([100, 1000])(
  'settles %s queued polls a teardown abandons while every read slot is stalled',
  async (panes) => {
    const stalled = stallEveryReadSlot()
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
    await drain(stalled)
  }
)

it.each([100, 1000])(
  'expires %s queued leases, refuses new reads during a stall, and recovers in FIFO order',
  async (owners) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const stalled = stallEveryReadSlot()
    await vi.advanceTimersByTimeAsync(10_000)

    const live = ['/next', '/following'].map((path) =>
      rolloutFileSizeAsync(path, new RolloutReadBatch())
    )
    const expiresAt = Date.now() + 1000
    const expired: (number | null)[] = []
    for (let index = 0; index < owners; index++) {
      void rolloutFileSizeAsync(
        `/expiring-${index}`,
        new RolloutReadBatch(undefined, undefined, () => expiresAt)
      ).then((size) => expired.push(size))
    }
    await vi.advanceTimersByTimeAsync(999)
    expect(expired).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(expired).toEqual(Array(owners).fill(null))
    expect(fs.stats).toBe(3)
    expect(warn).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(9000)
    await expect(Promise.all(stalled)).resolves.toEqual([null, null, null])
    const refused: (number | null)[] = []
    for (let index = 0; index < owners; index++) {
      void rolloutFileSizeAsync(`/replacement-${index}`, new RolloutReadBatch()).then((size) =>
        refused.push(size)
      )
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(refused).toEqual(Array(owners).fill(null))
    expect(fs.stats).toBe(3)
    expect(vi.getTimerCount()).toBe(2)
    expect(warn).toHaveBeenCalledTimes(1)

    fs.stalled.shift()!()
    await vi.advanceTimersByTimeAsync(0)
    expect(fs.started).toEqual(['/stalled', '/stalled', '/stalled', '/next'])
    fs.stalled.pop()!()
    await vi.advanceTimersByTimeAsync(0)
    expect(fs.started.at(-1)).toBe('/following')
    fs.stalled.pop()!()
    await expect(Promise.all(live)).resolves.toEqual([7, 7])

    const stalledAgain = rolloutFileSizeAsync('/stalled-again', new RolloutReadBatch())
    await vi.advanceTimersByTimeAsync(20_000)
    await expect(stalledAgain).resolves.toBeNull()
    expect(warn).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    await drain(stalled)
  }
)

it('keeps native read buffers reserved through timeouts, owner replacement, and handle close', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const mib = 1024 * 1024
  const healthy = vi.fn(async () => {})
  fs.cursors.set('/healthy', { read: healthy, close: async () => {} })
  const read = (path: string, batch: RolloutReadBatch) =>
    readJsonlCursorBytes({ filePath: path, offset: 0, carry: '' }, batch)
  const retained = Array.from({ length: 3 }, () => new RolloutReadBatch())
  for (const batch of retained) {
    for (let index = 0; index < 4; index++) {
      await expect(read('/healthy', batch)).resolves.toMatchObject({ bytes: { length: mib } })
    }
    await expect(read('/healthy', batch)).resolves.toBe('deferred')
  }

  const closes: (() => void)[] = []
  const finishes: (() => void)[] = []
  const owners = Array.from({ length: 3 }, () => new AbortController())
  const batches = owners.map(({ signal }) => new RolloutReadBatch(undefined, signal))
  const late = batches.map((batch, index) => {
    const path = `/held-${index}`
    fs.cursors.set(path, {
      read: () => new Promise<void>((resolve) => finishes.push(resolve)),
      close: () => new Promise<void>((resolve) => closes.push(resolve))
    })
    return read(path, batch)
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(finishes).toHaveLength(3)
  for (let index = 0; index < 2; index++) {
    owners[index]!.abort()
    batches[index]!.release()
  }
  await vi.advanceTimersByTimeAsync(20_000)
  await expect(Promise.all(late)).resolves.toEqual(['deferred', 'deferred', 'deferred'])
  batches[2]!.release()

  finishes[0]!()
  await vi.advanceTimersByTimeAsync(0)
  expect(closes).toHaveLength(1)
  const replacement = new RolloutReadBatch()
  await expect(read('/healthy', replacement)).resolves.toBe('deferred')
  expect(healthy).toHaveBeenCalledTimes(12)
  closes[0]!()
  await vi.advanceTimersByTimeAsync(0)

  await expect(read('/healthy', replacement)).resolves.toMatchObject({ bytes: { length: mib } })
  await expect(read('/healthy', replacement)).resolves.toMatchObject({ bytes: { length: mib } })
  await expect(read('/healthy', replacement)).resolves.toBe('deferred')
  expect(healthy).toHaveBeenCalledTimes(14)

  finishes[1]!()
  finishes[2]!()
  await vi.advanceTimersByTimeAsync(0)
  expect(closes).toHaveLength(3)
  closes[1]!()
  closes[2]!()
  await vi.advanceTimersByTimeAsync(0)
  await expect(read('/healthy', replacement)).resolves.toMatchObject({ bytes: { length: mib } })
  expect(vi.getTimerCount()).toBe(0)
  for (const batch of [...retained, replacement]) {
    batch.release()
  }
})

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

it('defers overflow at the admission cap and admits a retry behind the accepted FIFO', async () => {
  const stalled = stallEveryReadSlot()
  const paths = Array.from({ length: 4096 }, (_, index) => `/queued-${index}`)
  const queued = paths.map((path) => rolloutFileSizeAsync(path, new RolloutReadBatch()))
  const retry = new RolloutReadBatch()
  await expect(rolloutFileSizeAsync('/retry', retry)).resolves.toBeNull()

  fs.stalled.shift()!()
  await new Promise<void>((resolve) => setImmediate(resolve))
  const retried = rolloutFileSizeAsync('/retry', retry)
  await drain([...stalled, ...queued, retried])
  expect(await Promise.all(queued)).toEqual(Array(4096).fill(7))
  expect(await retried).toBe(7)
  expect(fs.started.slice(3)).toEqual([...paths, '/retry'])
})

it.each([100, 1000])(
  'unlinks %s individually retired polls without checking survivors until a slot frees',
  async (panes) => {
    const stalled = stallEveryReadSlot()
    const admitted: string[] = []
    const settled: string[] = []
    let checks = 0
    const scheduler = new AgentTranscriptPollScheduler<string>(1000, async (key, _, signal) => {
      admitted.push(key)
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
    try {
      for (const [index, key] of names.entries()) {
        scheduler.schedule(key, key, undefined, 1000 + index, 'codex')
      }
      vi.advanceTimersByTime(1000 + names.length - 1)
      expect(admitted).toEqual(names)
      checks = 0
      scheduler.schedule('pane-0', 'replacement', undefined, 1000, 'muse')
      scheduler.schedule('pane-1', 'newer hook', undefined, 1000, 'codex')
      await Promise.resolve()
      for (let index = 2; index < names.length; index += 2) {
        scheduler.clear(names[index]!)
        await Promise.resolve()
      }
      await vi.advanceTimersByTimeAsync(0)

      expect(checks).toBe(0)
      expect(settled).toEqual(names.filter((_, index) => index % 2 === 0))
      expect(fs.started).toEqual(['/stalled', '/stalled', '/stalled'])
      await drain(stalled)
      expect(fs.started.slice(3)).toEqual(names.filter((_, index) => index % 2 === 1))
    } finally {
      scheduler.clearAll()
      await drain(stalled)
    }
  }
)
