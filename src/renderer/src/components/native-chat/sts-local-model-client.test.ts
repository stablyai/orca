import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StsLocalModelClient } from './sts-local-model-client'

class FakeWorker {
  static latest: FakeWorker
  onmessage?: (event: { data: unknown }) => void
  onerror?: () => void
  terminate = vi.fn()
  requests: { id: number; type: string; audio?: Float32Array }[] = []
  constructor() {
    FakeWorker.latest = this
  }
  postMessage(request: { id: number; type: string; audio?: Float32Array }) {
    this.requests.push(request)
    if (request.type === 'init') {
      this.onmessage?.({ data: { id: request.id, ready: true } })
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('Worker', FakeWorker)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('does not create a worker when preparation finishes after the conversation closed', async () => {
  const client = new StsLocalModelClient()
  const load = vi.fn(async () => [])
  client.close()
  await expect(client.start(load)).rejects.toThrow('closed')
})

it('retains only the latest eight seconds, clears the audio, and cancels outstanding requests on close', async () => {
  const client = new StsLocalModelClient()
  await client.start(async () => [])
  for (let i = 0; i < 10; i++) {
    client.feed(new Float32Array(16000).fill(i), 16000)
  }
  const prediction = client.predict('끝', '', true)
  const rejection = expect(prediction).rejects.toThrow('closed')
  const worker = FakeWorker.latest
  const audio = worker.requests.at(-1)?.audio
  expect(audio?.length).toBe(128000)
  expect(audio?.[0]).toBe(2)
  expect(audio?.at(-1)).toBe(9)
  client.resetAudio()
  const next = client.predict('다음', '', true)
  const nextRejection = expect(next).rejects.toThrow('closed')
  expect(worker.requests.at(-1)?.audio?.length).toBe(0)
  client.close()
  await Promise.all([rejection, nextRejection])
  expect(worker.terminate).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('terminates a stalled worker instead of accumulating timed-out inference jobs', async () => {
  const client = new StsLocalModelClient()
  await client.start(async () => [])
  const prediction = client.predict('실행', '', false)
  const rejection = expect(prediction).rejects.toThrow('timeout')
  await vi.advanceTimersByTimeAsync(5000)
  await rejection
  expect(FakeWorker.latest.terminate).toHaveBeenCalledOnce()
  await expect(client.predict('재시도', '', false)).rejects.toThrow('unavailable')
})
