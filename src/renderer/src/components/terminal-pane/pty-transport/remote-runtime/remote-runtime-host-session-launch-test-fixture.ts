import { vi, type Mock } from 'vitest'
import { createTerminalStreamFixtures } from '@/components/terminal-pane/pty-transport/remote/remote-runtime-pty-transport-stream-fixtures'

export function createHostSessionLaunchRuntimeFixture() {
  const runtimeCall: Mock = vi.fn()
  const runtimeSubscribe: Mock = vi.fn()
  let subscriptionCallbacks: {
    onResponse: (response: unknown) => void
    onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
    onError?: (error: { code: string; message: string }) => void
    onClose?: () => void
  } | null = null
  const unsubscribeFn = vi.fn<() => void>()
  const sendBinary = vi.fn<(bytes: Uint8Array<ArrayBufferLike>) => void>()
  const unsubscribe = { unsubscribe: unsubscribeFn, sendBinary }
  function reset() {
    runtimeCall.mockReset()
    runtimeSubscribe.mockReset()
    subscriptionCallbacks = null
    unsubscribeFn.mockReset()
    sendBinary.mockReset()
    runtimeCall.mockImplementation(async (args: { method?: string }) =>
      args.method === 'status.get'
        ? {
            id: 'rpc-status',
            ok: true,
            result: {
              runtimeProtocolVersion: 3,
              minCompatibleRuntimeClientVersion: 2,
              capabilities: ['agent-session.host-authority.v1']
            },
            _meta: { runtimeId: 'runtime-remote' }
          }
        : {
            id: 'rpc-create',
            ok: true,
            result: {
              terminal: {
                handle: 'term-remote',
                worktreeId: 'repo1::/remote/wt',
                title: null,
                surface: 'background'
              }
            },
            _meta: { runtimeId: 'runtime-remote' }
          }
    )
    runtimeSubscribe.mockImplementation(
      async (_args: unknown, callbacks: typeof subscriptionCallbacks) => {
        subscriptionCallbacks = callbacks
        queueMicrotask(() => {
          subscriptionCallbacks?.onResponse({
            id: 'rpc-multiplex',
            ok: true,
            result: { type: 'ready' },
            _meta: { runtimeId: 'runtime-remote' }
          })
        })
        return unsubscribe
      }
    )
  }
  return {
    runtimeCall,
    runtimeSubscribe,
    unsubscribe,
    unsubscribeFn,
    reset,
    get subscriptionCallbacks() {
      return subscriptionCallbacks
    },
    latestRemoteSubscribePayload() {
      return createTerminalStreamFixtures({
        getCallbacks: () => subscriptionCallbacks,
        sendBinary
      }).latestSubscribePayload()
    }
  }
}
