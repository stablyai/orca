import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callRuntimeRpc = vi.fn()
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
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
})
