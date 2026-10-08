import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callRuntimeRpc = vi.fn()
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: (...args: unknown[]) => callRuntimeRpc(...args)
}))

import {
  clearNativeChatVisualCacheForTests,
  isRetryableNativeChatVisualFailure,
  peekCachedNativeChatVisual,
  readNativeChatVisual
} from './native-chat-visual-read-client'

const local = { target: { kind: 'local' as const }, sessionId: 'session-alpha', file: 'a.html' }
const remote = {
  target: { kind: 'environment' as const, environmentId: 'env-1' },
  sessionId: 'session-alpha',
  file: 'a.html'
}

beforeEach(() => {
  clearNativeChatVisualCacheForTests()
  callRuntimeRpc.mockReset()
})

afterEach(() => {
  clearNativeChatVisualCacheForTests()
})

describe('readNativeChatVisual', () => {
  it("reads through the chat's own runtime with only the session and file name", async () => {
    callRuntimeRpc.mockResolvedValueOnce({ ok: true, revision: 'r1', sizeBytes: 3, html: '<p>' })
    expect(await readNativeChatVisual(remote)).toEqual({
      ok: true,
      document: { revision: 'r1', html: '<p>' }
    })
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      remote.target,
      'agentSession.readVisual',
      { sessionId: 'session-alpha', file: 'a.html' },
      expect.any(Object)
    )
  })

  it('revalidates with the held revision and keeps the cached bytes when unchanged', async () => {
    callRuntimeRpc.mockResolvedValueOnce({ ok: true, revision: 'r1', sizeBytes: 3, html: '<p>' })
    await readNativeChatVisual(local)
    callRuntimeRpc.mockResolvedValueOnce({
      ok: true,
      revision: 'r1',
      sizeBytes: 3,
      unchanged: true
    })
    expect(await readNativeChatVisual(local)).toEqual({
      ok: true,
      document: { revision: 'r1', html: '<p>' }
    })
    expect(callRuntimeRpc.mock.calls[1][2]).toEqual({
      sessionId: 'session-alpha',
      file: 'a.html',
      knownRevision: 'r1'
    })
  })

  it('shows a rewritten file as its new revision', async () => {
    callRuntimeRpc.mockResolvedValueOnce({ ok: true, revision: 'r1', sizeBytes: 3, html: '<p>' })
    await readNativeChatVisual(local)
    callRuntimeRpc.mockResolvedValueOnce({ ok: true, revision: 'r2', sizeBytes: 4, html: '<hr>' })
    expect(await readNativeChatVisual(local)).toEqual({
      ok: true,
      document: { revision: 'r2', html: '<hr>' }
    })
    expect(peekCachedNativeChatVisual(local)?.revision).toBe('r2')
  })

  it('keeps one runtime from answering for another', async () => {
    callRuntimeRpc.mockResolvedValueOnce({ ok: true, revision: 'r1', sizeBytes: 3, html: '<p>' })
    await readNativeChatVisual(local)
    expect(peekCachedNativeChatVisual(remote)).toBeNull()
  })

  it('shares one in-flight read between concurrent mounts', async () => {
    let resolve: (value: unknown) => void = () => {}
    callRuntimeRpc.mockReturnValueOnce(new Promise((next) => (resolve = next)))
    const first = readNativeChatVisual(local)
    const second = readNativeChatVisual(local)
    resolve({ ok: true, revision: 'r1', sizeBytes: 3, html: '<p>' })
    expect(await first).toEqual(await second)
    expect(callRuntimeRpc).toHaveBeenCalledTimes(1)
  })

  it('reads a lost connection or an older host as unavailable, never as a verdict', async () => {
    callRuntimeRpc.mockRejectedValueOnce(new Error('method_not_found'))
    expect(await readNativeChatVisual(local)).toEqual({ ok: false, reason: 'unavailable' })
    callRuntimeRpc.mockRejectedValueOnce(new Error('socket closed'))
    expect(await readNativeChatVisual(local)).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('passes host refusals through, degrades an unknown one, and forgets a refused file', async () => {
    callRuntimeRpc.mockResolvedValueOnce({ ok: true, revision: 'r1', sizeBytes: 3, html: '<p>' })
    await readNativeChatVisual(local)
    callRuntimeRpc.mockResolvedValueOnce({ ok: false, error: 'not_found' })
    expect(await readNativeChatVisual(local)).toEqual({ ok: false, reason: 'not_found' })
    expect(peekCachedNativeChatVisual(local)).toBeNull()
    callRuntimeRpc.mockResolvedValueOnce({ ok: true, revision: 'r2', sizeBytes: 3, html: '<p>' })
    await readNativeChatVisual(local)
    callRuntimeRpc.mockResolvedValueOnce({ ok: false, error: 'too_large' })
    expect(await readNativeChatVisual(local)).toEqual({ ok: false, reason: 'too_large' })
    // A rewrite the host now refuses must not keep showing the old bytes on the next mount.
    expect(peekCachedNativeChatVisual(local)).toBeNull()
    callRuntimeRpc.mockResolvedValueOnce({ ok: false, error: 'some_future_reason' })
    expect(await readNativeChatVisual(local)).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('asks again for the bytes when an unchanged answer finds nothing cached', async () => {
    callRuntimeRpc.mockResolvedValueOnce({ ok: true, revision: 'r1', sizeBytes: 3, html: '<p>' })
    await readNativeChatVisual(local)
    clearNativeChatVisualCacheForTests()
    callRuntimeRpc
      .mockResolvedValueOnce({ ok: true, revision: 'r1', sizeBytes: 3, unchanged: true })
      .mockResolvedValueOnce({ ok: true, revision: 'r1', sizeBytes: 3, html: '<p>' })
    expect(await readNativeChatVisual(local)).toEqual({
      ok: true,
      document: { revision: 'r1', html: '<p>' }
    })
  })

  it('bounds the cache by entry count', async () => {
    for (let index = 0; index < 30; index += 1) {
      callRuntimeRpc.mockResolvedValueOnce({
        ok: true,
        revision: `r${index}`,
        sizeBytes: 1,
        html: 'x'
      })
      await readNativeChatVisual({ ...local, file: `f${index}.html` })
    }
    expect(peekCachedNativeChatVisual({ ...local, file: 'f0.html' })).toBeNull()
    expect(peekCachedNativeChatVisual({ ...local, file: 'f29.html' })?.revision).toBe('r29')
  })
})

describe('isRetryableNativeChatVisualFailure', () => {
  it('retries only what may change on its own', () => {
    expect(isRetryableNativeChatVisualFailure('unavailable')).toBe(true)
    expect(isRetryableNativeChatVisualFailure('not_found')).toBe(true)
    expect(isRetryableNativeChatVisualFailure('outside_folder')).toBe(false)
    expect(isRetryableNativeChatVisualFailure('too_large')).toBe(false)
  })
})
