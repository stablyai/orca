import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { subscribeRuntimeEnvironment } from '../../runtime/rpc/environment-revisions/runtime-environment-pairing-refresh'
import { createWebSpeechApi } from './web-speech-api'

const { subscribe, callRuntimeResult } = vi.hoisted(() => ({
  subscribe: vi.fn<typeof subscribeRuntimeEnvironment>(),
  callRuntimeResult: vi.fn()
}))

vi.mock('../../runtime/rpc/environment-revisions/runtime-environment-pairing-refresh', () => ({
  subscribeRuntimeEnvironment: subscribe
}))
vi.mock('./web-runtime-calls', () => ({ callRuntimeResult }))

function deliver(result: unknown): void {
  const callbacks = subscribe.mock.calls[0]?.[1]
  if (!callbacks) {
    throw new Error('Missing speech subscription')
  }
  callbacks.onResponse({ id: 'speech-events', ok: true, result, _meta: { runtimeId: 'host-1' } })
}

describe('runtime-backed desktop speech', () => {
  beforeEach(() => {
    subscribe.mockReset().mockResolvedValue({ unsubscribe: vi.fn(), sendBinary: vi.fn() })
    callRuntimeResult.mockReset()
  })

  it('validates incoming events and keeps subscription readiness out of dictation callbacks', async () => {
    const api = createWebSpeechApi()
    const onReady = vi.fn()
    const onTranscript = vi.fn()
    const unsubscribeReady = api.onReady(onReady)
    const unsubscribeTranscript = api.onPartialTranscript(onTranscript)
    await Promise.resolve()

    deliver({ type: 'ready', subscriptionId: 'subscription-1' })
    deliver({ type: 'partial', sessionId: 'session-1', text: 123 })
    deliver(null)
    expect(onReady).not.toHaveBeenCalled()
    expect(onTranscript).not.toHaveBeenCalled()

    deliver({ type: 'ready', sessionId: 'session-1', futureField: true })
    deliver({ type: 'partial', sessionId: 'session-1', text: 'Hello' })
    expect(onReady).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-1' })
    expect(onTranscript).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-1', text: 'Hello' })
    expect(subscribe).toHaveBeenCalledOnce()

    unsubscribeReady()
    unsubscribeTranscript()
    deliver({ type: 'ready', sessionId: 'session-1' })
    deliver({ type: 'partial', sessionId: 'session-1', text: 'Ignored' })
    expect(onReady).toHaveBeenCalledOnce()
    expect(onTranscript).toHaveBeenCalledOnce()
  })

  it('delivers each event to its matching listener', () => {
    const api = createWebSpeechApi()
    const onFinal = vi.fn()
    const onStopped = vi.fn()
    const onError = vi.fn()
    const onProgress = vi.fn()
    const unsubscribes = [
      api.onFinalTranscript(onFinal),
      api.onStopped(onStopped),
      api.onError(onError),
      api.onDownloadProgress(onProgress)
    ]

    deliver({ type: 'final', sessionId: 'session-2', text: 'Done' })
    deliver({ type: 'stopped', sessionId: 'session-2' })
    deliver({ type: 'error', sessionId: 'session-2', error: 'Unavailable' })
    deliver({ type: 'downloadProgress', modelId: 'model-1', progress: 0.5 })
    expect(onFinal).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-2', text: 'Done' })
    expect(onStopped).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-2' })
    expect(onError).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'session-2',
      error: 'Unavailable'
    })
    expect(onProgress).toHaveBeenCalledExactlyOnceWith({ modelId: 'model-1', progress: 0.5 })
    for (const unsubscribe of unsubscribes) {
      unsubscribe()
    }
  })
})
