// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('../components/terminal/terminal-provider-snapshot-capability', () => ({
  collectTerminalProviderSnapshotPtyIds: () => [],
  refreshTerminalProviderSnapshotCapabilities: async () => undefined
}))
vi.mock('../store', async () => {
  const { create } = await import('zustand')
  const useAppStore = create(() => ({
    startupWorktreeRefreshCompleted: false,
    terminalStartupRestorationReady: false,
    workspaceSessionReady: false
  }))
  return { useAppStore }
})

import { useAppStore } from '../store'
import { recoverFromDegradedStartup } from './startup-degraded-recovery'

function recover(args: {
  isCancelled: () => boolean
  reconnectPersistedTerminals: () => Promise<void>
}): Promise<void> {
  return recoverFromDegradedStartup({
    error: new Error('hydration failed'),
    uiHydrated: true,
    reconnectStarted: false,
    hydratePersistedUI: vi.fn(),
    abortSignal: new AbortController().signal,
    ...args
  })
}

describe('recoverFromDegradedStartup', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    useAppStore.setState({ terminalStartupRestorationReady: false, workspaceSessionReady: false })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        app: {
          awaitFirstWindowStartupServices: async () => undefined,
          recoverLegacyWorkerTerminalsForRendererStartup: async () => undefined,
          relaunch: vi.fn()
        }
      }
    })
  })

  it('releases terminal startup restoration once the degraded reconnect succeeds', async () => {
    await recover({
      isCancelled: () => false,
      reconnectPersistedTerminals: async () => {
        useAppStore.setState({ workspaceSessionReady: true })
      }
    })

    expect(useAppStore.getState().terminalStartupRestorationReady).toBe(true)
  })

  it('leaves the flag to the newer pass when this one was cancelled mid-reconnect', async () => {
    let cancelled = false
    await recover({
      isCancelled: () => cancelled,
      reconnectPersistedTerminals: async () => {
        cancelled = true
      }
    })

    expect(useAppStore.getState().terminalStartupRestorationReady).toBe(false)
  })
})
