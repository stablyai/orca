// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

import { toast } from 'sonner'
import { useAppStore } from '../store'
import type { RuntimeHostStatusSnapshot } from '../../../shared/remote-runtime/host-status/runtime-host-status'
import { recoverFromDegradedStartup } from './startup-degraded-recovery'
import '../web/web-runtime-client-error'

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

  describe('on the paired web client', () => {
    let statusListener: ((snapshot: RuntimeHostStatusSnapshot) => void) | null
    let currentTransport: RuntimeHostStatusSnapshot['transport']
    const relaunch = vi.fn()

    function snapshot(
      transport: RuntimeHostStatusSnapshot['transport']
    ): RuntimeHostStatusSnapshot {
      return {
        environmentId: 'env-1',
        pairingRevision: 1,
        sequence: 1,
        checkedAt: 0,
        status: null,
        verification: 'unavailable',
        transport
      }
    }

    function recoverFrom(
      error: Error,
      pass: { signal?: AbortSignal; isCancelled?: () => boolean } = {}
    ): Promise<void> {
      return recoverFromDegradedStartup({
        error,
        uiHydrated: true,
        reconnectStarted: false,
        hydratePersistedUI: vi.fn(),
        abortSignal: pass.signal ?? new AbortController().signal,
        isCancelled: pass.isCancelled ?? (() => false),
        reconnectPersistedTerminals: async () => {
          throw new Error('Could not connect to the remote Orca runtime.')
        }
      })
    }

    beforeEach(() => {
      vi.mocked(toast.error).mockClear()
      relaunch.mockClear()
      statusListener = null
      currentTransport = 'disconnected'
      Reflect.set(window, '__ORCA_WEB_CLIENT__', true)
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: {
          app: {
            awaitFirstWindowStartupServices: async () => undefined,
            recoverLegacyWorkerTerminalsForRendererStartup: async () => undefined,
            relaunch
          },
          runtimeEnvironments: {
            getStatusSnapshots: async () => [snapshot(currentTransport)],
            onStatusChanged: (listener: (snapshot: RuntimeHostStatusSnapshot) => void) => {
              statusListener = listener
              return () => {
                statusListener = null
              }
            }
          }
        }
      })
    })

    afterEach(() => {
      Reflect.deleteProperty(window, '__ORCA_WEB_CLIENT__')
    })

    it('says the host is unreachable and reloads once it answers', async () => {
      await recoverFrom(new Error('Could not connect to the remote Orca runtime.'))

      expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toBe("Couldn't reach your Orca host")
      statusListener?.(snapshot('connecting'))
      expect(relaunch).not.toHaveBeenCalled()
      statusListener?.(snapshot('ready'))
      statusListener?.(snapshot('ready'))
      expect(relaunch).toHaveBeenCalledTimes(1)
    })

    it('stops waiting to reload once its startup pass is torn down', async () => {
      const pass = new AbortController()
      await recoverFrom(new Error('Could not connect to the remote Orca runtime.'), {
        signal: pass.signal
      })
      pass.abort()

      statusListener?.(snapshot('ready'))
      expect(relaunch).not.toHaveBeenCalled()
    })

    it('does not announce or arm a reload for a pass cancelled during the check', async () => {
      let cancelled = false
      const getStatusSnapshots = window.api.runtimeEnvironments.getStatusSnapshots
      window.api.runtimeEnvironments.getStatusSnapshots = async () => {
        cancelled = true
        return getStatusSnapshots()
      }
      await recoverFrom(new Error('Could not connect to the remote Orca runtime.'), {
        isCancelled: () => cancelled
      })

      expect(toast.error).not.toHaveBeenCalled()
      expect(statusListener).toBeNull()
    })
  })
})
