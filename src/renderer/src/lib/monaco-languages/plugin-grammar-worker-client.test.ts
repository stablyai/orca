// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PLUGIN_GRAMMAR_INIT_DEADLINE_MS,
  PLUGIN_GRAMMAR_PROGRESS_DEADLINE_MS,
  type PluginGrammarWorkerMessage
} from './plugin-grammar-protocol'
import { PluginGrammarWorkerClient, type PluginGrammarWorker } from './plugin-grammar-worker-client'

class FakeWorker implements PluginGrammarWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  readonly messages: PluginGrammarWorkerMessage[] = []
  terminated = false
  postMessage(message: PluginGrammarWorkerMessage): void {
    this.messages.push(message)
  }
  terminate(): void {
    this.terminated = true
  }
  reply(data: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data }))
  }
  lastJob(): number {
    const jobs = this.messages.filter((message) => message.type === 'tokenize')
    const last = jobs.at(-1)
    return last && last.type === 'tokenize' ? last.id : -1
  }
}

/** A client whose workers finish setup at once, unless `autoReady` is off. */
function client(autoReady = true) {
  const workers: FakeWorker[] = []
  const instance = new PluginGrammarWorkerClient('source.demo', [], () => {
    const worker = new FakeWorker()
    workers.push(worker)
    if (autoReady) {
      queueMicrotask(() => worker.reply({ type: 'ready', ok: true }))
    }
    return worker
  })
  return { instance, workers }
}

const complete = (id: number) => ({
  id,
  type: 'complete',
  lines: 1,
  data: new Uint32Array([0, 0, 2, 0])
})

const signal = () => new AbortController().signal

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  vi.useRealTimers()
})

describe('PluginGrammarWorkerClient', () => {
  it('drops a superseded document by id without killing the worker', async () => {
    const { instance, workers } = client()
    const controller = new AbortController()
    const stale = instance.tokenize('old', [3], controller.signal)
    const fresh = instance.tokenize('ab', [2], signal())
    await flush()
    const worker = workers[0]
    const staleId = worker?.lastJob() ?? -1
    controller.abort()
    await expect(stale).resolves.toEqual({ ok: false, reason: 'aborted' })
    expect(worker?.messages).toContainEqual({ type: 'cancel', id: staleId })
    worker?.reply({ id: staleId, type: 'unavailable' })
    await flush()
    worker?.reply(complete(worker.lastJob()))
    await expect(fresh).resolves.toMatchObject({ ok: true })
    expect(worker?.terminated).toBe(false)
  })

  it('refuses tokens that do not fit the document', async () => {
    const { instance, workers } = client()
    const result = instance.tokenize('ab', [2], signal())
    await flush()
    workers[0]?.reply({ ...complete(workers[0].lastJob()), data: new Uint32Array([0, 1, 9, 0]) })
    await expect(result).resolves.toEqual({ ok: false, reason: 'unavailable' })
  })

  it('gives setup its own deadline, so a slow start never counts as a stall', async () => {
    vi.useFakeTimers()
    const { instance, workers } = client(false)
    const pending = instance.tokenize('ab', [2], signal())
    vi.advanceTimersByTime(PLUGIN_GRAMMAR_PROGRESS_DEADLINE_MS * 3)
    expect(workers[0]?.terminated).toBe(false)
    expect(workers[0]?.lastJob()).toBe(-1)
    workers[0]?.reply({ type: 'ready', ok: true })
    workers[0]?.reply(complete(workers[0].lastJob()))
    await expect(pending).resolves.toMatchObject({ ok: true })
  })

  it('stalls when setup never finishes, and reports a grammar that cannot compile', async () => {
    vi.useFakeTimers()
    const slow = client(false)
    const never = slow.instance.tokenize('ab', [2], signal())
    vi.advanceTimersByTime(PLUGIN_GRAMMAR_INIT_DEADLINE_MS + 1)
    await expect(never).resolves.toEqual({ ok: false, reason: 'stalled' })
    expect(slow.workers[0]?.terminated).toBe(true)

    const broken = client(false)
    const failed = broken.instance.tokenize('ab', [2], signal())
    broken.workers[0]?.reply({ type: 'ready', ok: false })
    await expect(failed).resolves.toEqual({ ok: false, reason: 'unavailable' })
  })

  it('terminates a worker that stops reporting progress, then starts a fresh one', async () => {
    vi.useFakeTimers()
    const { instance, workers } = client(false)
    const stuck = instance.tokenize('slow', [4], signal())
    workers[0]?.reply({ type: 'ready', ok: true })
    vi.advanceTimersByTime(PLUGIN_GRAMMAR_PROGRESS_DEADLINE_MS + 1)
    await expect(stuck).resolves.toEqual({ ok: false, reason: 'stalled' })
    expect(workers[0]?.terminated).toBe(true)
    void instance.tokenize('next', [4], signal())
    expect(workers).toHaveLength(2)
  })

  it('reports a crash and an oversized document', async () => {
    const { instance, workers } = client()
    const crashed = instance.tokenize('x', [1], signal())
    workers[0]?.onerror?.(new ErrorEvent('error'))
    await expect(crashed).resolves.toEqual({ ok: false, reason: 'crashed' })
    await expect(
      instance.tokenize(
        'z',
        Array.from({ length: 25_000 }, () => 1),
        signal()
      )
    ).resolves.toEqual({ ok: false, reason: 'size' })
  })
})
