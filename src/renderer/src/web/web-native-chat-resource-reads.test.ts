import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { WebRuntimeSubscriptionCallbacks } from './web-runtime-subscription-contract'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

beforeEach(() => vi.resetModules())
afterEach(() => {
  vi.unstubAllGlobals()
  vi.doUnmock('./web-runtime-client')
})

const request = { agent: 'codex' as const, sessionId: 'same-session', version: 'v1' }
function response(result: unknown): RuntimeRpcResponse<unknown> {
  return { id: 'reply', ok: true, result, _meta: { runtimeId: 'runtime-a' } }
}

it('falls back through the normal browser stream when optional discovery rejects', async () => {
  const call = vi.fn().mockRejectedValue(new Error('Optional probe unavailable'))
  const unsubscribe = vi.fn()
  const subscribe = vi.fn(
    async (_method: string, _params: unknown, callbacks: WebRuntimeSubscriptionCallbacks) => {
      callbacks.onResponse(response({ type: 'snapshot', messages: [], hasMore: false }))
      return { unsubscribe, sendBinary: vi.fn() }
    }
  )
  vi.doMock('./web-runtime-client', () => ({
    WebRuntimeClient: class {
      call = call
      subscribe = subscribe
      close(): void {}
    }
  }))
  const globals = installBrowserGlobals()
  writeStoredRuntimeEnvironment(globals.storage, 'host-a')
  const { createWebNativeChatApi } = await import('./preload-api/web-native-chat-api')
  const { webRuntimeState } = await import('./preload-api/web-runtime-session')
  const api = createWebNativeChatApi({ environment: webRuntimeState.activeEnvironment })
  const onFrame = vi.fn()
  const stop = api.subscribe(
    { agent: 'codex', sessionId: 'same-session', subscriptionId: 'pane-a' },
    onFrame
  )
  await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce())
  expect(subscribe.mock.calls[0][1]).toMatchObject({
    subscriptionId: 'pane-a',
    capabilities: { transcriptPending: 1, transcriptSourceOrder: 1 }
  })
  expect(subscribe.mock.calls[0][1]).not.toHaveProperty('capabilities.currentRequests')
  expect(onFrame).toHaveBeenCalledWith({ type: 'snapshot', messages: [], hasMore: false })
  stop()
  await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce())
})

it('rejects a queued resource read after re-pairing instead of sending it to the replacement host', async () => {
  let release = () => {}
  const blocked = new Promise<RuntimeRpcResponse<unknown>>((resolve) => {
    release = () => resolve(response(null))
  })
  const call = vi.fn(() => blocked)
  vi.doMock('./web-runtime-client', () => ({
    WebRuntimeClient: class {
      call = call
      close(): void {}
    }
  }))
  const globals = installBrowserGlobals()
  writeStoredRuntimeEnvironment(globals.storage, 'host-a')
  const { createWebNativeChatApi } = await import('./preload-api/web-native-chat-api')
  const { callEnvironmentEnvelope } = await import('./preload-api/web-runtime-calls')
  const { webRuntimeState } = await import('./preload-api/web-runtime-session')
  const environment = webRuntimeState.activeEnvironment
  if (!environment) {
    throw new Error('Expected paired environment')
  }
  const api = createWebNativeChatApi({ environment })
  const blockers = Array.from({ length: 8 }, () => callEnvironmentEnvelope('host-a', 'hold'))
  await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(8))
  const refused = expect(api.currentRequests(request)).rejects.toThrow('paired Orca server changed')
  webRuntimeState.activeEnvironment = { ...environment, pairingRevision: 2 }
  release()
  await Promise.all(blockers)
  await refused
  expect(call).toHaveBeenCalledTimes(8)
})

it.each(['pairing', 'host'] as const)(
  'rejects a resource completion after captured %s replacement',
  async (replacement) => {
    let release = (_reply: RuntimeRpcResponse<unknown>) => {}
    const call = vi.fn(
      () =>
        new Promise<RuntimeRpcResponse<unknown>>((resolve) => {
          release = resolve
        })
    )
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call = call
        close(): void {}
      }
    }))
    const globals = installBrowserGlobals()
    writeStoredRuntimeEnvironment(globals.storage, 'host-a')
    const { createWebNativeChatApi } = await import('./preload-api/web-native-chat-api')
    const { webRuntimeState } = await import('./preload-api/web-runtime-session')
    const environment = webRuntimeState.activeEnvironment
    if (!environment) {
      throw new Error('Expected paired environment')
    }
    const api = createWebNativeChatApi({ environment })
    const refused = expect(api.currentRequests(request)).rejects.toThrow(
      replacement === 'pairing' ? 'paired Orca server changed' : 'Unknown Orca runtime environment'
    )
    await vi.waitFor(() => expect(call).toHaveBeenCalledOnce())
    webRuntimeState.activeEnvironment =
      replacement === 'pairing'
        ? { ...environment, pairingRevision: 2 }
        : { ...environment, id: 'host-b' }
    release(response({ marker: {}, json: '[]', nextCursor: null }))
    await refused
    expect(call).toHaveBeenCalledTimes(1)
  }
)
