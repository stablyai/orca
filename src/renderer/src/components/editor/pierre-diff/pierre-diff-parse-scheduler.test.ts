import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileDiffMetadata } from '@pierre/diffs'
import { createPierreDiffParseScheduler } from './pierre-diff-parse-scheduler'
import type {
  PierreDiffParseRequest,
  PierreDiffParseResponse,
  PierreDiffParseWorker
} from './pierre-diff-parse-protocol'

class FakeWorker implements PierreDiffParseWorker {
  postMessage = vi.fn()
  terminate = vi.fn()
  onmessage: PierreDiffParseWorker['onmessage'] = null
  onerror: PierreDiffParseWorker['onerror'] = null
  onmessageerror: PierreDiffParseWorker['onmessageerror'] = null
  reply(data: PierreDiffParseResponse) {
    this.onmessage?.({ data } as MessageEvent<PierreDiffParseResponse>)
  }
}
const request = (id: number): PierreDiffParseRequest => ({
  id,
  identity: `identity:${id}`,
  input: {
    path: 'file',
    status: 'modified',
    originalContent: 'before',
    modifiedContent: 'after',
    parseDiffOptions: {}
  }
})
const diff = { name: 'file', hunks: [] } as unknown as FileDiffMetadata
const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn())
  vi.useRealTimers()
})
function setup() {
  const workers: FakeWorker[] = []
  const scheduler = createPierreDiffParseScheduler(() => {
    const worker = new FakeWorker()
    workers.push(worker)
    return worker
  })
  cleanups.push(() => scheduler.dispose())
  return { workers, scheduler }
}

describe('diff parse worker scheduling', () => {
  it('caps workers, queues files, and reuses workers without dropping content', async () => {
    const { workers, scheduler } = setup()
    const results = [1, 2, 3].map((id) =>
      scheduler.request(request(id), new AbortController().signal)
    )
    expect(workers).toHaveLength(2)
    workers[0].reply({ id: 1, diff })
    expect(workers[0].postMessage).toHaveBeenLastCalledWith(request(3))
    workers[1].reply({ id: 2, diff })
    workers[0].reply({ id: 3, diff })
    expect(await Promise.all(results)).toEqual([diff, diff, diff])
    expect(workers[0].terminate).not.toHaveBeenCalled()
  })

  it('terminates an obsolete active parse so a new visible file can start immediately', async () => {
    const { workers, scheduler } = setup()
    const old = new AbortController()
    const first = scheduler.request(request(1), old.signal).catch((error) => error.name)
    const second = scheduler.request(request(2), new AbortController().signal)
    const next = scheduler.request(request(3), new AbortController().signal)
    old.abort()
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    expect(workers[2].postMessage).toHaveBeenCalledWith(request(3))
    workers[1].reply({ id: 2, diff })
    workers[2].reply({ id: 3, diff })
    expect(await first).toBe('AbortError')
    await Promise.all([second, next])
  })

  it('never starts a queued request whose viewer has unmounted', async () => {
    const { workers, scheduler } = setup()
    const results = [1, 2].map((id) => scheduler.request(request(id), new AbortController().signal))
    const canceled = new AbortController()
    const queued = scheduler.request(request(3), canceled.signal).catch((error) => error.name)
    canceled.abort()
    workers[0].reply({ id: 1, diff })
    workers[1].reply({ id: 2, diff })
    await Promise.all(results)
    expect(await queued).toBe('AbortError')
    expect(
      workers.flatMap((worker) => worker.postMessage.mock.calls).map(([entry]) => entry.id)
    ).toEqual([1, 2])
  })

  it('rejects worker failures and lets later requests recover', async () => {
    const { workers, scheduler } = setup()
    const failed = scheduler
      .request(request(1), new AbortController().signal)
      .catch((error) => error.message)
    workers[0].onerror?.({ message: 'worker failed' } as ErrorEvent)
    expect(await failed).toBe('worker failed')
    const recovered = scheduler.request(request(2), new AbortController().signal)
    workers[1].reply({ id: 2, diff })
    expect(await recovered).toBe(diff)
  })

  it('ignores stale responses and frees idle worker heaps', async () => {
    vi.useFakeTimers()
    const { workers, scheduler } = setup()
    const result = scheduler.request(request(1), new AbortController().signal)
    workers[0].reply({ id: 99, error: 'stale' })
    expect(workers[0].terminate).not.toHaveBeenCalled()
    workers[0].reply({ id: 1, diff })
    await result
    vi.advanceTimersByTime(5_000)
    expect(workers[0].terminate).toHaveBeenCalledOnce()
  })

  it('rejects all active and pending work on shutdown', async () => {
    const { workers, scheduler } = setup()
    const results = [1, 2, 3].map((id) =>
      scheduler.request(request(id), new AbortController().signal).catch((error) => error.name)
    )
    scheduler.dispose()
    expect(await Promise.all(results)).toEqual(['AbortError', 'AbortError', 'AbortError'])
    expect(workers.every((worker) => worker.terminate.mock.calls.length === 1)).toBe(true)
  })
})
