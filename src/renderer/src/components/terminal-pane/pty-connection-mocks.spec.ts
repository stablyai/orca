import type { createIpcPtyTransport } from './pty-transport'
import type { createRemoteRuntimePtyTransport } from './remote-runtime-pty-transport'
import type * as React from 'react'
import { vi } from 'vitest'
import type { Mock } from 'vitest'
import type { MockTransport } from './pty-connection-test-pane-fixtures'
import type { StoreState } from './pty-connection-test-store-state'

type StoreSubscriber = (state: StoreState) => void

type PtyConnectionTestBindings = {
  getState: () => StoreState
  getRemoteTransportFactory?: () => typeof createRemoteRuntimePtyTransport | undefined
  getIpcTransportFactory?: () => typeof createIpcPtyTransport | undefined
  getTransportQueue: () => MockTransport[]
  getTransportOptions: () => Record<string, unknown>[]
  getStoreSubscribers: () => StoreSubscriber[]
  setStoreSubscribers: (subscribers: StoreSubscriber[]) => void
}

type PtyConnectionTestMocks = {
  resetAndRefreshAllTerminalWebglAtlases: Mock
  scheduleTerminalWebglAtlasRecovery: Mock
  scheduleRuntimeGraphSync: Mock
  shouldSeedCacheTimerOnInitialTitle: Mock<() => boolean>
  toastInfo: Mock
  notifyCodexPaneBoundForStaleSweep: Mock
}

const fixture = vi.hoisted(() => {
  let bindings: PtyConnectionTestBindings | undefined
  return {
    mocks: {
      resetAndRefreshAllTerminalWebglAtlases: vi.fn(),
      scheduleTerminalWebglAtlasRecovery: vi.fn(),
      scheduleRuntimeGraphSync: vi.fn(),
      shouldSeedCacheTimerOnInitialTitle: vi.fn(() => false),
      toastInfo: vi.fn(),
      notifyCodexPaneBoundForStaleSweep: vi.fn()
    },
    bind(next: PtyConnectionTestBindings): void {
      bindings = next
    },
    current(): PtyConnectionTestBindings {
      if (!bindings) {
        throw new Error('No PTY connection test state is bound')
      }
      return bindings
    }
  }
})

export const ptyConnectionTestMocks: PtyConnectionTestMocks = fixture.mocks

export function bindPtyConnectionTestMocks(bindings: PtyConnectionTestBindings): void {
  fixture.bind(bindings)
}

function takeMockTransport(options: Record<string, unknown>): MockTransport {
  const bindings = fixture.current()
  bindings.getTransportOptions().push(options)
  options.productionOptions = { ...options }
  const transport = bindings.getTransportQueue().shift()
  if (!transport) {
    throw new Error('No mock transport queued')
  }
  return transport
}

vi.mock('@/runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync: fixture.mocks.scheduleRuntimeGraphSync
}))

vi.mock('@/lib/pane-manager/pane-manager-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resetAndRefreshAllTerminalWebglAtlases: fixture.mocks.resetAndRefreshAllTerminalWebglAtlases
}))

vi.mock('./terminal-webgl-atlas-recovery', () => ({
  scheduleTerminalWebglAtlasRecovery: fixture.mocks.scheduleTerminalWebglAtlasRecovery
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => fixture.current().getState(),
    subscribe: (listener: StoreSubscriber) => {
      // Unsubscribe must keep the suite that created the subscription.
      const bindings = fixture.current()
      bindings.getStoreSubscribers().push(listener)
      return () => {
        bindings.setStoreSubscribers(
          bindings.getStoreSubscribers().filter((candidate) => candidate !== listener)
        )
      }
    }
  }
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const { buildAgentStatusModuleMock } = await import('./pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})

vi.mock('./cache-timer-seeding', () => ({
  shouldSeedCacheTimerOnInitialTitle: fixture.mocks.shouldSeedCacheTimerOnInitialTitle
}))

vi.mock('sonner', () => ({
  toast: {
    info: fixture.mocks.toastInfo
  }
}))

vi.mock('@/lib/codex-stale-pane-sweep', () => ({
  notifyCodexPaneBoundForStaleSweep: fixture.mocks.notifyCodexPaneBoundForStaleSweep
}))

// Notification hooks run outside React in these suites.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return {
    ...actual,
    useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn
  }
})

async function transportMockFactory() {
  return (options: Record<string, unknown>): MockTransport => {
    const transport = takeMockTransport(options)
    let boundPtyId: string | null = transport.getPtyId()
    const getPolicy = () => {
      const ptyId = boundPtyId ?? transport.getPtyId()
      return ptyId
        ? globalThis.terminalConnectionTestDelivery?.getResident(ptyId)?.policy
        : undefined
    }
    let admitted: string | undefined
    const admit = (ptyId: string | null, incarnationId?: string) => {
      if (ptyId && typeof options.onSourceAdmitted === 'function' && admitted !== ptyId) {
        admitted = ptyId
        options.onSourceAdmitted(ptyId, incarnationId)
      }
    }
    // Parsed callback injections represent the physical source in these pane suites.
    const forward = <Args extends unknown[]>(
      name: string,
      select: (policy: NonNullable<ReturnType<typeof getPolicy>>) => (...args: Args) => unknown
    ) => {
      const original = options[name]
      options[name] = (...args: Args) => {
        admit(boundPtyId ?? transport.getPtyId())
        const policy = getPolicy()
        if (policy) {
          return select(policy)(...args)
        }
        if (typeof original === 'function') {
          return original(...args)
        }
        throw new Error(`Physical source not admitted for test injection ${name}`)
      }
    }
    forward('onTitleChange', (policy) => policy.callbacks.onTitleChange)
    forward('onBell', (policy) => policy.callbacks.onBell)
    forward('onAgentBecameIdle', (policy) => policy.callbacks.onAgentBecameIdle)
    forward('onAgentBecameWorking', (policy) => policy.callbacks.onAgentBecameWorking)
    forward('onAgentExited', (policy) => policy.callbacks.onAgentExited)
    forward('onAgentStatus', (policy) => policy.callbacks.onAgentStatus)
    const onSpawn = options.onPtySpawn
    if (typeof onSpawn === 'function') {
      options.onPtySpawn = (ptyId: string) => {
        boundPtyId = ptyId
        admit(ptyId)
        return onSpawn(ptyId)
      }
    }
    const sendInput = transport.sendInput.getMockImplementation()
    if (!sendInput) {
      throw new Error('Expected the transport input implementation before resident wrapping')
    }
    transport.sendInput.mockImplementation((data, kind, call) => {
      const id = boundPtyId ?? transport.getPtyId()
      if (id) {
        admit(id)
        call?.onEligible(id)
        call?.onDispatch(id)
      }
      return sendInput(data, kind, call)
    })
    const acceptedInput = transport.sendInputAccepted
    if (acceptedInput) {
      const accepted = acceptedInput.getMockImplementation()
      if (!accepted) {
        throw new Error('Expected the accepted-input implementation before resident wrapping')
      }
      acceptedInput.mockImplementation((data, kind, acceptedOptions) => {
        const id = boundPtyId ?? transport.getPtyId()
        if (id) {
          admit(id)
          acceptedOptions?.call?.onDispatch(id)
        }
        return accepted(data, kind, acceptedOptions)
      })
    }
    const attach = transport.attach.getMockImplementation()
    transport.attach.mockImplementation((opts) => {
      const result = attach?.(opts)
      boundPtyId = transport.getPtyId()
      // This fixture's successful attach stands for the positive inventory result.
      admit(boundPtyId)
      return result
    })
    const connect = transport.connect.getMockImplementation()
    let rawEndSeq = 0
    transport.connect.mockImplementation(async (opts) => {
      const callbacks = opts.callbacks
      const onData = callbacks?.onData
      if (callbacks && onData) {
        callbacks.onData = (data, meta) => {
          admit(boundPtyId ?? transport.getPtyId())
          rawEndSeq = meta?.seq ?? rawEndSeq + data.length
          meta ??= { seq: rawEndSeq, rawLength: data.length }
          if (typeof options.onRawData === 'function') {
            options.onRawData(data, meta)
          }
          onData(data, meta)
          const ptyId = boundPtyId ?? transport.getPtyId()
          if (ptyId) {
            for (const sidecar of globalThis.terminalConnectionTestDelivery?.sidecars.get(ptyId) ??
              []) {
              sidecar(data, meta)
            }
          }
        }
      }
      const result = await connect?.(opts)
      boundPtyId = typeof result === 'string' ? result : (result?.id ?? transport.getPtyId())
      admit(
        boundPtyId,
        typeof result === 'object' && result !== null ? result.incarnationId : undefined
      )
      return result
    })
    return transport
  }
}

vi.mock('./pty-transport', async () => {
  const create = await transportMockFactory()
  return {
    createIpcPtyTransport: vi.fn((options: Record<string, unknown>) => {
      const real = fixture.current().getIpcTransportFactory?.()
      return real ? real(options) : create(options)
    })
  }
})

vi.mock('./remote-runtime-pty-transport', async () => {
  const create = await transportMockFactory()
  return {
    createRemoteRuntimePtyTransport: vi.fn(
      (environmentId: string, options: Record<string, unknown>) => {
        const real = fixture.current().getRemoteTransportFactory?.()
        return real ? real(environmentId, options) : create(options)
      }
    )
  }
})

// Only the eager-buffer read is replaced; the remaining dispatcher stays real.
vi.mock('./pty-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    getEagerPtyBufferHandle: vi.fn(() => undefined)
  }
})
