import {
  RuntimeRpcEnvelopeSchema,
  type RuntimeRpcResponse
} from '../../src/shared/runtime-rpc-envelope'
import { vi, type Mock } from 'vitest'
import type { RpcContext } from '../../src/main/runtime/rpc/core'
import { registerRuntimeHandlers } from '../../src/main/ipc/runtime'
import { RpcDispatcher } from '../../src/main/runtime/rpc/dispatcher'
import { runtimeApi } from '../../src/preload/api/runtime-bridge'
import type { RuntimeEnvironmentSubscriptionHandle } from '../../src/preload/runtime-environment-subscriptions'

type DesktopListener = (_event: unknown, response: RuntimeRpcResponse<unknown>) => void
type DesktopIpcEvent = {
  sender: {
    id: number
    mainFrame: unknown
    on: ReturnType<typeof vi.fn>
    once: ReturnType<typeof vi.fn>
    isDestroyed: () => boolean
    send: (channel: string, response: RuntimeRpcResponse<unknown>) => void
  }
  senderFrame: unknown
}
const desktopIpc = vi.hoisted(() => ({
  handlers: new Map<string, (event: DesktopIpcEvent, args: unknown) => unknown>(),
  events: new Map<string, (event: DesktopIpcEvent, args: unknown) => void>(),
  listeners: new Map<string, Set<DesktopListener>>(),
  invoke: vi.fn(),
  send: vi.fn()
}))
vi.mock('electron', () => ({
  BrowserWindow: {},
  ipcMain: {
    handle: (channel: string, handler: (event: DesktopIpcEvent, args: unknown) => unknown) =>
      desktopIpc.handlers.set(channel, handler),
    on: (channel: string, handler: (event: DesktopIpcEvent, args: unknown) => void) =>
      desktopIpc.events.set(channel, handler),
    removeHandler: (channel: string) => desktopIpc.handlers.delete(channel),
    removeAllListeners: (channel: string) => desktopIpc.events.delete(channel)
  },
  ipcRenderer: {
    invoke: desktopIpc.invoke,
    send: desktopIpc.send,
    on: (channel: string, listener: DesktopListener) => {
      let listeners = desktopIpc.listeners.get(channel)
      if (!listeners) {
        listeners = new Set()
        desktopIpc.listeners.set(channel, listeners)
      }
      listeners.add(listener)
    },
    removeListener: (channel: string, listener: DesktopListener) => {
      const listeners = desktopIpc.listeners.get(channel)
      listeners?.delete(listener)
      if (listeners?.size === 0) {
        desktopIpc.listeners.delete(channel)
      }
    }
  }
}))
vi.mock('../../src/main/runtime/rpc/methods', async () => ({
  ALL_RPC_METHODS: (await import('../../src/main/runtime/rpc/methods/accounts')).ACCOUNT_METHODS
}))

type AccountStreamDesktopRuntime = Pick<
  RpcContext['runtime'],
  | 'getAccountsStreamSnapshot'
  | 'onAccountsChanged'
  | 'registerSubscriptionCleanup'
  | 'cleanupSubscription'
  | 'cleanupSubscriptionsForConnection'
  | 'getRuntimeId'
  | 'refreshAccountsForMobileSubscriber'
>
type DesktopHandlerPort = { register(runtime: AccountStreamDesktopRuntime): void }

export function accountStreamDesktopFixture(
  runtime: AccountStreamDesktopRuntime,
  frames: unknown[]
) {
  const slots: {
    emit: (frame: unknown) => void
    fail: () => void
    end: () => void
    unsubscribe: Mock<RuntimeEnvironmentSubscriptionHandle['unsubscribe']>
    releaseHandle: () => void
    releaseDispatch: () => void
    serverId?: string
  }[] = []
  const running: Promise<void>[] = []
  let holdHandles = false
  let holdDispatch = false
  const pending = new Set<Promise<void>>()
  const slotsById = new Map<string, (typeof slots)[number]>()
  const dispatch = RpcDispatcher.prototype.dispatchStreaming
  vi.spyOn(RpcDispatcher.prototype, 'dispatchStreaming').mockImplementation(function (
    this: RpcDispatcher,
    request,
    reply,
    options
  ) {
    const slot = slotsById.get(request.id)
    if (!slot) {
      throw new Error('Missing desktop subscription')
    }
    const admitted = Promise.withResolvers<void>()
    slot.releaseDispatch = () => admitted.resolve()
    if (!holdDispatch) {
      admitted.resolve()
    }
    const work = admitted.promise.then(() =>
      dispatch.call(
        this,
        request,
        (wire) => {
          const response = RuntimeRpcEnvelopeSchema.parse(JSON.parse(wire))
          if ('ok' in response && response.ok) {
            frames.push(response.result)
            const frame = response.result
            if (
              frame &&
              typeof frame === 'object' &&
              'subscriptionId' in frame &&
              typeof frame.subscriptionId === 'string'
            ) {
              slot.serverId = frame.subscriptionId
            }
          }
          reply(wire)
        },
        options
      )
    )
    pending.add(work)
    void work.finally(() => pending.delete(work))
    running.push(work)
    return work
  })
  const sender = {
    id: 35392,
    mainFrame: {},
    on: vi.fn(),
    once: vi.fn(),
    isDestroyed: () => false,
    send: (channel: string, response: RuntimeRpcResponse<unknown>) => {
      for (const listener of desktopIpc.listeners.get(channel) ?? []) {
        listener({}, response)
      }
    }
  }
  const event = { sender, senderFrame: sender.mainFrame }
  const desktopHandlers: DesktopHandlerPort = { register: registerRuntimeHandlers }
  desktopHandlers.register(runtime)
  let opening: (typeof slots)[number] | undefined
  desktopIpc.invoke.mockImplementation((channel: string, args: unknown) => {
    if (
      channel !== 'runtime:subscribe' ||
      !opening ||
      !args ||
      typeof args !== 'object' ||
      !('subscriptionId' in args) ||
      typeof args.subscriptionId !== 'string'
    ) {
      throw new Error('Unexpected desktop invocation')
    }
    slotsById.set(args.subscriptionId, opening)
    return desktopIpc.handlers.get(channel)?.(event, args)
  })
  desktopIpc.send.mockImplementation((channel: string, args: unknown) => {
    desktopIpc.events.get(channel)?.(event, args)
  })
  const subscribe = vi.fn(
    async (
      request: { method: string; params?: unknown },
      onResponse: (response: RuntimeRpcResponse<unknown>) => void
    ) => {
      if (request.method !== 'accounts.subscribe') {
        throw new Error('Unexpected stream')
      }
      const handle = Promise.withResolvers<void>()
      const slot: (typeof slots)[number] = {
        emit: (frame) => {
          frames.push(frame)
          onResponse({ id: 'injected', ok: true, result: frame, _meta: { runtimeId: 'fixture' } })
        },
        fail: () =>
          onResponse({
            id: 'injected',
            ok: false,
            error: { code: 'fixture_error', message: 'Disconnected' }
          }),
        end: () => {
          if (slot.serverId) {
            runtime.cleanupSubscription(slot.serverId)
          }
        },
        unsubscribe: vi.fn(),
        releaseHandle: () => handle.resolve(),
        releaseDispatch: () => {}
      }
      slots.push(slot)
      opening = slot
      const acquiring = runtimeApi.subscribe(request, onResponse)
      slot.unsubscribe.mockImplementation(() => {
        void acquiring.then((transport) => transport.unsubscribe())
      })
      opening = undefined
      const transport = await acquiring
      slot.unsubscribe.mockImplementation(() => transport.unsubscribe())
      if (holdHandles) {
        await handle.promise
      }
      return { ...transport, unsubscribe: slot.unsubscribe }
    }
  )
  return {
    subscribe,
    slots,
    pendingStreams: () => pending.size,
    transportListeners: () => desktopIpc.listeners.size,
    holdHandles: (hold: boolean) => {
      holdHandles = hold
    },
    holdDispatch: (hold: boolean) => {
      holdDispatch = hold
    },
    dispose: async () => {
      for (const slot of slots) {
        slot.releaseHandle()
        slot.unsubscribe()
        slot.releaseDispatch()
      }
      await Promise.all(running)
    }
  }
}
