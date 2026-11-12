import { MessageChannel, type MessagePort } from 'node:worker_threads'
import { afterEach, expect, it, vi } from 'vitest'
import { BackendPortRpc, type BackendPort } from '../../../../../shared/backend-port-rpc'
import { createStore } from 'zustand/vanilla'
import { createClaudeUsageSlice } from './usage-provider-slices'
import { createUsageProviderApi } from '../../../../../preload/usage-provider-api'
import type { AppState } from '../../types'
import type { ClaudeUsageScanState } from '../../../../../shared/claude-usage-types'
import {
  BACKEND_CONNECTION_CHANGED,
  BACKEND_PORT_DELIVERY
} from '../../../../../shared/backend-service-contract'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => void>(),
  invoke: vi.fn(async (_channel: string, _token: string, _purpose?: string) => {})
}))
vi.mock('electron', () => ({
  ipcRenderer: {
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      electron.handlers.set(channel, listener)
    },
    invoke: electron.invoke
  }
}))

const servers: BackendPortRpc[] = []
const ports: MessagePort[] = []
const detach: (() => void)[] = []

function emit(channel: string, data: unknown, delivered: MessagePort[] = []): void {
  electron.handlers.get(channel)?.({ ports: delivered }, data)
}

function deliver(invoke: (method: string, params?: unknown) => Promise<unknown>): () => void {
  const channel = new MessageChannel()
  const added = vi.spyOn(channel.port2, 'addEventListener')
  ports.push(channel.port1, channel.port2)
  const adapter: BackendPort = {
    postMessage: (message) => channel.port1.postMessage(message),
    onMessage(listener) {
      channel.port1.on('message', listener)
      return () => channel.port1.off('message', listener)
    },
    onClose(listener) {
      channel.port1.on('close', listener)
      return () => channel.port1.off('close', listener)
    },
    close: () => channel.port1.close()
  }
  servers.push(new BackendPortRpc(adapter, 'backend', invoke))
  emit(BACKEND_PORT_DELIVERY, { token: electron.invoke.mock.lastCall?.[1] }, [channel.port2])
  const close = added.mock.calls.find(([event]) => event === 'close')?.[1]
  return () => {
    if (typeof close === 'function') {
      close.call(channel.port2, new Event('close'))
    } else {
      close?.handleEvent(new Event('close'))
    }
  }
}

afterEach(() => {
  detach.splice(0).forEach((unsubscribe) => unsubscribe())
  emit(BACKEND_CONNECTION_CHANGED, { connected: false })
  servers.splice(0).forEach((server) => server.close())
  ports.splice(0).forEach((port) => port.close())
  electron.handlers.clear()
  electron.invoke.mockClear()
  vi.restoreAllMocks()
  vi.resetModules()
  vi.unstubAllGlobals()
})

it('publishes port loss before rejection and preserves fresh work through duplicate loss', async () => {
  const { backendUsageTransport: transport } =
    await import('../../../../../preload/backend-port-client')
  const events: string[] = []
  let fresh: Promise<unknown> | undefined
  detach.push(
    transport.onConnectionChanged((connected, detail) => {
      if (detail?.initial || detail?.unavailable) {
        return
      }
      events.push(connected ? 'ready' : 'lost')
      if (!connected) {
        fresh = transport.invoke('snapshot')
      }
    })
  )
  const started = Promise.withResolvers<void>()
  const held = Promise.withResolvers<unknown>()
  const first = transport.invoke('snapshot').catch(() => events.push('rejected'))
  emit(BACKEND_CONNECTION_CHANGED, { connected: true })
  const closeAgain = deliver(async () => {
    started.resolve()
    return held.promise
  })
  await started.promise
  servers[0].close()
  await first
  expect(events).toEqual(['ready', 'lost', 'rejected'])
  expect(electron.invoke).toHaveBeenCalledTimes(2)
  emit(BACKEND_CONNECTION_CHANGED, { connected: false })
  emit(BACKEND_CONNECTION_CHANGED, { connected: false })
  deliver(async () => ({ inputTokens: 123 }))
  await expect(fresh).resolves.toEqual({ inputTokens: 123 })
  closeAgain()
  expect(events).toEqual(['ready', 'lost', 'rejected', 'ready'])
  held.resolve(null)
  await expect(transport.invoke('snapshot')).resolves.toEqual({ inputTokens: 123 })
  expect(electron.invoke).toHaveBeenCalledTimes(2)
})

it('keeps a replacement handshake when the old handshake rejects after loss', async () => {
  const { backendUsageTransport: transport } =
    await import('../../../../../preload/backend-port-client')
  let fresh: Promise<unknown> | undefined
  detach.push(
    transport.onConnectionChanged((connected, detail) => {
      if (detail?.initial || detail?.unavailable) {
        return
      }
      if (!connected) {
        fresh = transport.invoke('snapshot')
      }
    })
  )
  const first = transport.invoke('snapshot')
  const rejected = expect(first).rejects.toThrow('Usage disconnected')
  emit(BACKEND_CONNECTION_CHANGED, { connected: false })
  await rejected
  emit(BACKEND_CONNECTION_CHANGED, { connected: false })
  deliver(async () => ({ inputTokens: 123 }))
  await expect(fresh).resolves.toEqual({ inputTokens: 123 })
  expect(electron.invoke).toHaveBeenCalledTimes(2)
})

it('initializes terminal presentation without RPCs and preserves a fresh handshake through terminal escalation', async () => {
  const { backendUsageTransport: transport } =
    await import('../../../../../preload/backend-port-client')
  emit(BACKEND_CONNECTION_CHANGED, { connected: false })
  const fresh = transport.invoke('snapshot')
  emit(BACKEND_CONNECTION_CHANGED, { connected: false, unavailable: true })
  const statuses: unknown[] = []
  detach.push(
    transport.onConnectionChanged((connected, detail) => statuses.push({ connected, detail }))
  )
  expect(statuses).toEqual([{ connected: false, detail: { initial: true, unavailable: true } }])
  expect(electron.invoke).toHaveBeenCalledTimes(1)
  deliver(async () => ({ inputTokens: 123 }))
  await expect(fresh).resolves.toEqual({ inputTokens: 123 })
  expect(statuses.at(-1)).toEqual({ connected: true, detail: undefined })
})

it('clears terminal metadata on main ready without port delivery or mounted demand', async () => {
  const { backendUsageTransport: transport } =
    await import('../../../../../preload/backend-port-client')
  emit(BACKEND_CONNECTION_CHANGED, { connected: false, unavailable: true })
  emit(BACKEND_CONNECTION_CHANGED, { connected: true })
  const statuses: unknown[] = []
  detach.push(
    transport.onConnectionChanged((connected, detail) => statuses.push({ connected, detail }))
  )
  expect(statuses).toEqual([{ connected: true, detail: { initial: true, unavailable: false } }])
  expect(electron.invoke).not.toHaveBeenCalled()
})

it('promotes pending recovery once and ignores its stale delivery and rejection', async () => {
  const { backendUsageTransport: transport } =
    await import('../../../../../preload/backend-port-client')
  const old = Promise.withResolvers<void>()
  electron.invoke.mockImplementationOnce(() => old.promise)
  const recovery = transport.invoke('snapshot', undefined, 'recovery')
  const oldToken = electron.invoke.mock.lastCall?.[1]
  const demand = transport.invoke('snapshot')
  const sharedDemand = transport.invoke('snapshot')
  expect(electron.invoke.mock.calls.map((call) => call[2])).toEqual(['recovery', 'demand'])
  expect(electron.invoke.mock.lastCall?.[1]).not.toBe(oldToken)
  const stale = new MessageChannel()
  ports.push(stale.port1, stale.port2)
  const close = vi.spyOn(stale.port2, 'close')
  emit(BACKEND_PORT_DELIVERY, { token: oldToken }, [stale.port2])
  expect(close).toHaveBeenCalledOnce()
  old.reject(new Error('Old document replaced'))
  await Promise.resolve()
  deliver(async () => ({ inputTokens: 123 }))
  await expect(Promise.all([recovery, demand, sharedDemand])).resolves.toEqual([
    { inputTokens: 123 },
    { inputTokens: 123 },
    { inputTokens: 123 }
  ])
  expect(electron.invoke).toHaveBeenCalledTimes(2)
})

it('cancels pending recovery on loss without rearming, and admits fresh post-loss demand', async () => {
  const { backendUsageTransport: transport } =
    await import('../../../../../preload/backend-port-client')
  const old = Promise.withResolvers<void>()
  electron.invoke.mockImplementationOnce(() => old.promise)
  const recovery = transport.invoke('snapshot', undefined, 'recovery')
  const failed = expect(recovery).rejects.toThrow('Usage disconnected')
  emit(BACKEND_CONNECTION_CHANGED, { connected: false })
  await failed
  expect(electron.invoke).toHaveBeenCalledTimes(1)
  const fresh = transport.invoke('snapshot')
  old.reject(new Error('Old acquisition failed'))
  await Promise.resolve()
  deliver(async () => 123)
  await expect(fresh).resolves.toBe(123)
  expect(electron.invoke.mock.calls.map((call) => call[2])).toEqual(['recovery', 'demand'])
})

it('carries mounted recovery purpose through both real usage reads without sending it to the service', async () => {
  const { backendUsageTransport: transport } =
    await import('../../../../../preload/backend-port-client')
  const invoke = vi.spyOn(transport, 'invoke')
  const scanState: ClaudeUsageScanState = {
    enabled: true,
    isScanning: false,
    lastScanStartedAt: null,
    lastScanCompletedAt: 1,
    lastScanError: null,
    hasAnyClaudeData: true
  }
  const snapshot = {
    scanState,
    summary: { inputTokens: 123 },
    daily: [],
    modelBreakdown: [],
    projectBreakdown: [],
    recentSessions: []
  }
  const received = vi.fn(async (method: string, _params?: unknown) =>
    method.endsWith(':getSnapshot') ? snapshot : scanState
  )
  vi.stubGlobal('window', {
    api: { claudeUsage: createUsageProviderApi(transport, 'claudeUsage') }
  })
  const store = createStore<AppState>()((...args) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture uses only the production usage slice's public state/actions.
    return createClaudeUsageSlice(...args) as AppState
  })
  detach.push(store.getState().observeClaudeUsage())
  await vi.waitFor(() => expect(electron.invoke).toHaveBeenCalledTimes(1))
  expect(electron.invoke.mock.lastCall?.[2]).toBe('demand')
  deliver(received)
  await store.getState().fetchClaudeUsage()
  invoke.mockClear()
  received.mockClear()
  emit(BACKEND_CONNECTION_CHANGED, { connected: false })
  emit(BACKEND_CONNECTION_CHANGED, { connected: true })
  await vi.waitFor(() => expect(electron.invoke).toHaveBeenCalledTimes(2))
  expect(electron.invoke.mock.lastCall?.[2]).toBe('recovery')
  deliver(received)
  await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(2))
  expect(invoke.mock.calls).toEqual([
    ['claudeUsage:getScanState', undefined, 'recovery'],
    ['claudeUsage:getSnapshot', { scope: 'orca', range: '30d', limit: 10 }, 'recovery']
  ])
  expect(received.mock.calls).toEqual([
    ['claudeUsage:getScanState', undefined, expect.any(AbortSignal)],
    ['claudeUsage:getSnapshot', { scope: 'orca', range: '30d', limit: 10 }, expect.any(AbortSignal)]
  ])
})
