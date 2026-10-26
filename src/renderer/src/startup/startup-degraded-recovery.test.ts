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
import type { RuntimeHostStatusSnapshot } from '../../../shared/runtime-host-status'
import { recoverFromDegradedStartup } from './startup-degraded-recovery'
import { createWebRuntimeUnauthorizedError } from '../web/web-runtime-client-error'

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

    it.each([
      'Timed out while connecting to the remote Orca runtime.',
      'Remote Orca runtime connection interrupted.'
    ])('treats "%s" as an unreachable host', async (message) => {
      await recoverFrom(new Error(message))

      expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toBe("Couldn't reach your Orca host")
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

    it('keeps the session-restore warning when the host was connected', async () => {
      currentTransport = 'ready'
      await recoverFrom(new Error('Timed out waiting for the remote Orca runtime.'))

      expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toBe('Session restore failed')
      expect(statusListener).toBeNull()
    })

    it('keeps the session-restore warning for a failure that is not about the connection', async () => {
      await recoverFrom(new Error('Persisted session schema is invalid'))

      expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toBe('Session restore failed')
    })

    it('shows why the host refused this browser instead of a session-restore failure', async () => {
      const refusal = createWebRuntimeUnauthorizedError('insecure-origin')
      await recoverFrom(refusal)

      const [title, options] = vi.mocked(toast.error).mock.calls[0] ?? []
      expect(title).toBe('Orca refused this browser')
      expect(options?.description).toBe(refusal.message)
      expect(refusal.message).toContain('ORCA_ALLOW_INSECURE_WEB_PAIRING=1')
      expect(statusListener).toBeNull()
    })
  })
})
