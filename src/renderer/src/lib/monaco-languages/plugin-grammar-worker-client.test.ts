// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginGrammarWorkerMessage } from './plugin-grammar-protocol'
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
})
