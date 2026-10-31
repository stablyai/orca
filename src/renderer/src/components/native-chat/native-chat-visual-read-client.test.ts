import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callRuntimeRpc = vi.fn()
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: (...args: unknown[]) => callRuntimeRpc(...args)
}))

import {
  clearNativeChatVisualCacheForTests,
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
  it('revalidates with the held revision and keeps the cached bytes when unchanged', async () => {
    callRuntimeRpc.mockResolvedValueOnce({ ok: true, revision: 'r1', html: '<p>', path: '/v' })
    await readNativeChatVisual(local)
    callRuntimeRpc.mockResolvedValueOnce({
      ok: true,
      revision: 'r1',
      sizeBytes: 3,
      unchanged: true
    })
    expect(await readNativeChatVisual(local)).toEqual({
      ok: true,
      document: { revision: 'r1', html: '<p>', path: '/v' }
    })
    expect(callRuntimeRpc.mock.calls[1][2]).toEqual({
      sessionId: 'session-alpha',
      file: 'a.html',
      knownRevision: 'r1'
    })
  })

  it('keeps one runtime from answering for another', async () => {
    callRuntimeRpc.mockResolvedValueOnce({ ok: true, revision: 'r1', html: '<p>', path: '/v' })
    await readNativeChatVisual(local)
    expect(peekCachedNativeChatVisual(remote)).toBeNull()
  })

  it('shares one in-flight read between concurrent mounts', async () => {
    let resolve: (value: unknown) => void = () => {}
    callRuntimeRpc.mockReturnValueOnce(new Promise((next) => (resolve = next)))
    const first = readNativeChatVisual(local)
    const second = readNativeChatVisual(local)
    resolve({ ok: true, revision: 'r1', html: '<p>', path: '/v' })
    expect(await first).toEqual(await second)
    expect(callRuntimeRpc).toHaveBeenCalledTimes(1)
  })

  it('passes host refusals through, degrades an unknown one, and forgets a refused file', async () => {
    callRuntimeRpc.mockResolvedValueOnce({ ok: true, revision: 'r1', html: '<p>', path: '/v' })
    await readNativeChatVisual(local)
    callRuntimeRpc.mockResolvedValueOnce({ ok: false, error: 'not_found' })
    expect(await readNativeChatVisual(local)).toEqual({ ok: false, reason: 'not_found' })
    expect(peekCachedNativeChatVisual(local)).toBeNull()
    callRuntimeRpc.mockResolvedValueOnce({ ok: true, revision: 'r2', html: '<p>', path: '/v' })
    await readNativeChatVisual(local)
    callRuntimeRpc.mockResolvedValueOnce({ ok: false, error: 'too_large' })
    expect(await readNativeChatVisual(local)).toEqual({ ok: false, reason: 'too_large' })
    // A rewrite the host now refuses must not keep showing the old bytes on the next mount.
    expect(peekCachedNativeChatVisual(local)).toBeNull()
    callRuntimeRpc.mockResolvedValueOnce({ ok: false, error: 'some_future_reason' })
    expect(await readNativeChatVisual(local)).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('bounds the cache by entry count', async () => {
    for (let index = 0; index < 30; index += 1) {
      callRuntimeRpc.mockResolvedValueOnce({
        ok: true,
        revision: `r${index}`,
        path: '/v',
        html: 'x'
      })
      await readNativeChatVisual({ ...local, file: `f${index}.html` })
    }
    expect(peekCachedNativeChatVisual({ ...local, file: 'f0.html' })).toBeNull()
    expect(peekCachedNativeChatVisual({ ...local, file: 'f29.html' })?.revision).toBe('r29')
  })
})
