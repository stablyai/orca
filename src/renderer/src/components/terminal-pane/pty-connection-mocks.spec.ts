// oxlint-disable anti-slop/no-module-mocking -- Test-only mocks shared by PTY connection registration suites.
import type * as React from 'react'
import { vi } from 'vitest'
import type { Mock } from 'vitest'
import type { MockTransport } from './pty-connection-test-pane-fixtures'
import type { StoreState } from './pty-connection-test-store-state'

type StoreSubscriber = (state: StoreState) => void

type PtyConnectionTestBindings = {
  getState: () => StoreState
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

vi.mock('./pty-transport', () => ({
  createIpcPtyTransport: vi.fn((options: Record<string, unknown>) => takeMockTransport(options))
}))

vi.mock('./remote-runtime-pty-transport', () => ({
  createRemoteRuntimePtyTransport: vi.fn(
    (_environmentId: string, options: Record<string, unknown>) => takeMockTransport(options)
  )
}))

// Only the eager-buffer read is replaced; the remaining dispatcher stays real.
vi.mock('./pty-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    getEagerPtyBufferHandle: vi.fn(() => undefined)
  }
})
