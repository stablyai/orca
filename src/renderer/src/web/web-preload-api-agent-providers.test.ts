import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

describe('web native chat preload API', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it('forwards the pending flag and still treats the real snapshot as the initial frame', async () => {
    const message = {
      id: 'a-1',
      role: 'assistant' as const,
      blocks: [{ type: 'text' as const, text: 'flushed' }],
      timestamp: 7,
      source: 'transcript' as const
    }
    let deliver: (result: unknown) => void = () => {}
    let subscribeParams: unknown
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        subscribe(
          _method: string,
          params: unknown,
          callbacks: { onResponse: (response: RuntimeRpcResponse<unknown>) => void }
        ): Promise<{ unsubscribe: () => void }> {
          subscribeParams = params
          deliver = (result) =>
            callbacks.onResponse({
              id: 'stream-1',
              ok: true,
              result,
              _meta: { runtimeId: 'runtime-1' }
            })
          return Promise.resolve({ unsubscribe: vi.fn() })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    const frames: unknown[] = []
    globals.window.api.nativeChat.subscribe(
      { subscriptionId: 'sub-1', agent: 'claude', sessionId: 'session-1', limit: 1 },
      (frame) => frames.push(frame)
    )
    await Promise.resolve()

    expect(subscribeParams).toMatchObject({
      capabilities: { transcriptPending: 1, transcriptSourceOrder: 1 }
    })

    // The host's unflushed-transcript frame, then the flush that follows it.
    deliver({ type: 'snapshot', messages: [], hasMore: false, pending: true })
    deliver({ type: 'snapshot', messages: [message] })

    // Pending is not settled history; hasMore proves only the later initial frame infers a full window from the limit.
    expect(frames).toEqual([
      { type: 'snapshot', messages: [], hasMore: false, pending: true },
      { type: 'snapshot', messages: [message], hasMore: true }
    ])
  })
})
