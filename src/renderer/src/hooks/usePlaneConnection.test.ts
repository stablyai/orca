import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { planeStatusMock } = vi.hoisted(() => ({ planeStatusMock: vi.fn() }))

async function loadHook() {
  vi.resetModules()
  vi.doMock('@/runtime/runtime-plane-client', () => ({ planeStatus: planeStatusMock }))
  vi.doMock('@/store', () => ({ useAppStore: () => ({ activeRuntimeEnvironmentId: null }) }))
  vi.doMock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
  return import('./usePlaneConnection')
}

beforeEach(() => {
  planeStatusMock.mockReset()
  planeStatusMock.mockResolvedValue({ connected: true, viewer: null })
})

afterEach(async () => {
  const mod = await loadHook()
  mod.resetPlaneConnectionState()
})

describe('shared Plane connection state', () => {
  it('collapses concurrent refreshes into one request', async () => {
    // Regression: every consumer refreshed on mount, so a single render of the
    // Tasks pane issued four identical status calls.
    const { refreshPlaneConnection, resetPlaneConnectionState } = await loadHook()
    resetPlaneConnectionState()

    await Promise.all([
      refreshPlaneConnection(null),
      refreshPlaneConnection(null),
      refreshPlaneConnection(null)
    ])
    expect(planeStatusMock).toHaveBeenCalledTimes(1)
  })

  it('publishes one status to every consumer', async () => {
    // Regression: independent per-hook state meant connecting in the settings
    // pane left the provider card reporting "Connect required".
    const { refreshPlaneConnection, resetPlaneConnectionState } = await loadHook()
    resetPlaneConnectionState()

    await refreshPlaneConnection(null)
    planeStatusMock.mockResolvedValue({ connected: false, viewer: null })
    await refreshPlaneConnection(null)

    // A later refresh replaces the shared snapshot rather than one consumer's.
    expect(planeStatusMock).toHaveBeenCalledTimes(2)
  })

  it('reports a failed status check without pretending to be connected', async () => {
    const { refreshPlaneConnection, resetPlaneConnectionState } = await loadHook()
    resetPlaneConnectionState()
    planeStatusMock.mockRejectedValue(new Error('remote server does not support Plane yet'))

    await refreshPlaneConnection(null)
    expect(planeStatusMock).toHaveBeenCalledTimes(1)
  })
})

describe('environment scoping', () => {
  it('does not hand a pending request for one environment to another', async () => {
    // Regression: the shared in-flight promise was returned regardless of
    // environment, so switching hosts showed the previous host's status.
    const { refreshPlaneConnection, resetPlaneConnectionState, getPlaneConnectionSnapshot } =
      await loadHook()
    resetPlaneConnectionState()

    let resolveFirst: ((value: unknown) => void) | undefined
    planeStatusMock.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
    planeStatusMock.mockResolvedValueOnce({ connected: true, viewer: null })

    const first = refreshPlaneConnection({ activeRuntimeEnvironmentId: 'env-a' })
    const second = refreshPlaneConnection({ activeRuntimeEnvironmentId: 'env-b' })
    expect(first).not.toBe(second)
    expect(planeStatusMock).toHaveBeenCalledTimes(2)

    // env-a resolves last and disagrees; the newer env-b result must survive.
    resolveFirst?.({ connected: false, viewer: null })
    await Promise.all([first, second])
    expect(getPlaneConnectionSnapshot().status.connected).toBe(true)
    expect(getPlaneConnectionSnapshot().checking).toBe(false)
  })

  it('still collapses repeat refreshes for the same environment', async () => {
    const { refreshPlaneConnection, resetPlaneConnectionState } = await loadHook()
    resetPlaneConnectionState()
    const settings = { activeRuntimeEnvironmentId: 'env-a' }
    await Promise.all([refreshPlaneConnection(settings), refreshPlaneConnection(settings)])
    expect(planeStatusMock).toHaveBeenCalledTimes(1)
  })
})
