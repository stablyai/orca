import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import { createBrowserSlice } from './browser'

const { callRuntimeRpcMock, sessionClearDefaultCookiesMock, sessionClearGoogleCookiesMock } =
  vi.hoisted(() => ({
    callRuntimeRpcMock: vi.fn(),
    sessionClearDefaultCookiesMock: vi.fn(),
    sessionClearGoogleCookiesMock: vi.fn()
  }))

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: callRuntimeRpcMock }))
vi.mock('@/runtime/web-runtime-session', () => ({ createWebRuntimeSessionBrowserTab: vi.fn() }))

globalThis.window = {
  api: {
    browser: {
      sessionClearDefaultCookies: sessionClearDefaultCookiesMock,
      sessionClearGoogleCookies: sessionClearGoogleCookiesMock
    } as never
  }
} as never

function createTestStore() {
  return create<AppState>()(
    (...args) =>
      ({
        settings: { activeRuntimeEnvironmentId: null } as AppState['settings'],
        ...createBrowserSlice(...args)
      }) as unknown as AppState
  )
}

describe('browser cookie clear host routing', () => {
  beforeEach(() => {
    callRuntimeRpcMock.mockReset().mockResolvedValue({ cleared: true })
    sessionClearDefaultCookiesMock.mockReset().mockResolvedValue(true)
    sessionClearGoogleCookiesMock.mockReset().mockResolvedValue(true)
  })

  it('sends the profile clear to the selected runtime host', async () => {
    const store = createTestStore()
    store.setState({ browserSessionHostIdOverride: 'runtime:selected-host' })

    await expect(store.getState().clearDefaultSessionCookies()).resolves.toBe(true)

    expect(callRuntimeRpcMock).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'selected-host' },
      'browser.profileClearDefaultCookies',
      undefined,
      { timeoutMs: 15_000 }
    )
    expect(sessionClearDefaultCookiesMock).not.toHaveBeenCalled()
  })

  // Why: the settings-focused host can be an SSH target the browser profile picker never offers.
  // Falling through to local IPC there would wipe this computer's cookies instead of that host's.
  it('refuses the profile clear rather than clearing local cookies for a non-local host', async () => {
    const store = createTestStore()
    store.setState({ browserSessionHostIdOverride: 'ssh:prod-box' })

    await expect(store.getState().clearDefaultSessionCookies()).resolves.toBe(false)

    expect(sessionClearDefaultCookiesMock).not.toHaveBeenCalled()
    expect(callRuntimeRpcMock).not.toHaveBeenCalled()
  })

  it('routes the Google clear to the selected runtime host and profile', async () => {
    const store = createTestStore()
    store.setState({ browserSessionHostIdOverride: 'runtime:selected-host' })

    await expect(store.getState().clearBrowserProfileGoogleCookies('profile-a')).resolves.toBe(true)

    expect(callRuntimeRpcMock).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'selected-host' },
      'browser.profileClearGoogleCookies',
      { profileId: 'profile-a' },
      { timeoutMs: 15_000 }
    )
    expect(sessionClearGoogleCookiesMock).not.toHaveBeenCalled()
  })

  // Why: the RPC result crosses the wire as `unknown` and is cast, not decoded. A host that never
  // answered this method can return a shape with no `cleared` at all, and reporting that as success
  // would tell the user their Google session is gone while it is still there.
  it('reports failure when a runtime host answers without a cleared flag', async () => {
    const store = createTestStore()
    store.setState({ browserSessionHostIdOverride: 'runtime:selected-host' })
    callRuntimeRpcMock.mockResolvedValue({ ok: true })

    await expect(store.getState().clearBrowserProfileGoogleCookies('profile-a')).resolves.toBe(
      false
    )
    await expect(store.getState().clearDefaultSessionCookies()).resolves.toBe(false)
  })

  // Why: browser.profileClearGoogleCookies is new, so an older runtime host rejects it outright.
  it('reports failure when an older runtime host does not know the method', async () => {
    const store = createTestStore()
    store.setState({ browserSessionHostIdOverride: 'runtime:selected-host' })
    callRuntimeRpcMock.mockRejectedValue(
      new Error('Unknown method: browser.profileClearGoogleCookies')
    )

    await expect(store.getState().clearBrowserProfileGoogleCookies('profile-a')).resolves.toBe(
      false
    )
  })

  it('routes the Google clear through local IPC for the local host', async () => {
    const store = createTestStore()
    store.setState({ browserSessionHostIdOverride: 'local' })

    await expect(store.getState().clearBrowserProfileGoogleCookies('profile-a')).resolves.toBe(true)

    expect(sessionClearGoogleCookiesMock).toHaveBeenCalledWith({ profileId: 'profile-a' })
    expect(callRuntimeRpcMock).not.toHaveBeenCalled()
  })

  it('refuses the Google clear for a non-local, non-runtime host', async () => {
    const store = createTestStore()
    store.setState({ browserSessionHostIdOverride: 'ssh:prod-box' })

    await expect(store.getState().clearBrowserProfileGoogleCookies('profile-a')).resolves.toBe(
      false
    )

    expect(sessionClearGoogleCookiesMock).not.toHaveBeenCalled()
    expect(callRuntimeRpcMock).not.toHaveBeenCalled()
  })
})
