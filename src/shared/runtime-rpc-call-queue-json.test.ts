import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeRpcCallQueuePool } from './runtime-rpc-call-queue'
import { stringifyJsonWithinByteLimit } from './node-bounded-json-stringify'

afterEach(() => vi.unstubAllGlobals())

describe('runtime JSON call queue', () => {
  it('releases aggregate byte admission on cancellation across independent hosts', async () => {
    const queue = new RuntimeRpcCallQueuePool(1, 1, 10, 10, 256)
    let release = (): void => {}
    const blocker = queue.enqueue(
      'host-a',
      'files.write',
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const controller = new AbortController()
    const cancelledRun = vi.fn(async () => {})
    const queued = queue.enqueueJson(
      'host-a',
      'files.write',
      { content: 'x'.repeat(20) },
      cancelledRun,
      controller.signal
    )
    const cancelled = expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    try {
      await expect(
        queue.enqueueJson('host-b', 'files.write', {}, async () => {})
      ).rejects.toMatchObject({ scope: 'memory' })
      controller.abort()
      await cancelled
      await expect(
        queue.enqueueJson('host-b', 'files.write', {}, async () => 'recovered')
      ).resolves.toBe('recovered')
      expect(cancelledRun).not.toHaveBeenCalled()
    } finally {
      controller.abort()
      release()
      await blocker
    }
  })

  it('captures params and authority once before the caller mutates them', async () => {
    const queue = new RuntimeRpcCallQueuePool(1, 1)
    let release = (): void => {}
    const blocker = queue.enqueue(
      'host-a',
      'files.write',
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const params = { content: 'original' }
    const envelope = { orchestrationRequestId: 'original-id' }
    const run = vi.fn(async () => {})
    const queued = queue.enqueueJson('host-a', 'files.write', params, run, undefined, envelope)
    params.content = 'changed'
    envelope.orchestrationRequestId = 'changed-id'
    release()
    await Promise.all([blocker, queued])
    expect(run).toHaveBeenCalledWith(
      { content: 'original' },
      { orchestrationRequestId: 'original-id' }
    )
  })

  it('bounds JSON in a browser without Buffer using the same escaping and Unicode budget', () => {
    const value = { text: 'quote " slash \\ control\n emoji 🐋 lone \ud800', array: [1, null] }
    const expected = JSON.stringify(value, null, 2)
    const expectedBytes = Buffer.byteLength(expected)
    vi.stubGlobal('Buffer', undefined)
    expect(stringifyJsonWithinByteLimit(value, expectedBytes, 2)).toEqual({
      serialized: expected,
      byteLength: expectedBytes
    })
    expect(() => stringifyJsonWithinByteLimit(value, expectedBytes - 1, 2)).toThrow(/exceeds/)
  })
})
