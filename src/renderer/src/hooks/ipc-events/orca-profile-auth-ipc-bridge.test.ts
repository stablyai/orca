import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  OrcaCloudSignInProgress,
  OrcaProfileAuthStatus
} from '../../../../shared/orca-profiles'
import { createTestStore } from '../../store/slices/store-test-helpers'

type TestStore = ReturnType<typeof createTestStore>

const { storeHolder } = vi.hoisted((): { storeHolder: { current: TestStore | null } } => ({
  storeHolder: { current: null }
}))

vi.mock('../../store', () => ({
  useAppStore: {
    getState: () => storeHolder.current?.getState(),
    setState: (partial: { orcaProfileSignInProgress: OrcaCloudSignInProgress | null }) =>
      storeHolder.current?.setState(partial)
  }
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() }
}))

import { registerOrcaProfileAuthIpcBridge } from './orca-profile-auth-ipc-bridge'

const connectedAuthStatus: OrcaProfileAuthStatus = {
  activeProfileId: 'local-default',
  configured: true,
  state: 'connected',
  persistence: 'encrypted'
}

const reconnectRequiredAuthStatus: OrcaProfileAuthStatus = {
  activeProfileId: 'local-default',
  configured: true,
  state: 'reconnect-required',
  persistence: 'encrypted'
}

describe('orca profile auth IPC bridge', () => {
  let listener: (() => void) | null = null
  const unsubscribe = vi.fn()
  const authStatus = vi.fn()

  beforeEach(() => {
    listener = null
    unsubscribe.mockClear()
    authStatus.mockReset()
    vi.stubGlobal('window', {
      api: {
        orcaProfiles: {
          authStatus,
          onAuthStatusChanged: (callback: () => void) => {
            listener = callback
            return unsubscribe
          }
        }
      }
    })
  })

  it('re-fetches auth status on the push, flipping connected to reconnect-required', async () => {
    authStatus.mockResolvedValue(connectedAuthStatus)
    const store = createTestStore()
    storeHolder.current = store
    await store.getState().fetchOrcaProfileAuthStatus()
    expect(store.getState().orcaProfileAuthStatus).toEqual(connectedAuthStatus)

    const unsubs: (() => void)[] = []
    registerOrcaProfileAuthIpcBridge(unsubs)
    authStatus.mockResolvedValue(reconnectRequiredAuthStatus)
    listener?.()
    await vi.waitFor(() =>
      expect(store.getState().orcaProfileAuthStatus).toEqual(reconnectRequiredAuthStatus)
    )

    unsubs.forEach((dispose) => dispose())
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('skips registration when the preload bridge does not expose the event', () => {
    vi.stubGlobal('window', { api: { orcaProfiles: { authStatus } } })
    const unsubs: (() => void)[] = []

    registerOrcaProfileAuthIpcBridge(unsubs)

    expect(unsubs).toHaveLength(0)
  })
})

describe('orca profile sign-in progress IPC bridge', () => {
  let emitProgress: (progress: OrcaCloudSignInProgress | null) => void
  const snapshots: ((progress: OrcaCloudSignInProgress | null) => void)[] = []
  const WAITING = { link: 'https://login.example/authorize?state=a' }

  beforeEach(() => {
    snapshots.length = 0
    storeHolder.current = createTestStore()
    vi.stubGlobal('window', {
      api: {
        orcaProfiles: {
          onSignInProgressChanged: (
            callback: (progress: OrcaCloudSignInProgress | null) => void
          ) => {
            emitProgress = callback
            return () => {}
          },
          signInProgress: () =>
            new Promise<OrcaCloudSignInProgress | null>((resolve) => {
              snapshots.push(resolve)
            })
        }
      }
    })
  })

  const progress = (): OrcaCloudSignInProgress | null =>
    storeHolder.current?.getState().orcaProfileSignInProgress ?? null

  it('adopts a sign-in already in flight when the window loads', async () => {
    registerOrcaProfileAuthIpcBridge([])
    await vi.waitFor(() => expect(snapshots).toHaveLength(1))
    snapshots[0](WAITING)
    await vi.waitFor(() => expect(progress()).toEqual(WAITING))
  })

  it('lets a newer change win over a late snapshot', async () => {
    registerOrcaProfileAuthIpcBridge([])
    await vi.waitFor(() => expect(snapshots).toHaveLength(1))
    emitProgress(null)
    snapshots[0](WAITING)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(progress()).toBeNull()
  })

  it('ignores the snapshot of a registration torn down before it arrived', async () => {
    const first: (() => void)[] = []
    registerOrcaProfileAuthIpcBridge(first)
    await vi.waitFor(() => expect(snapshots).toHaveLength(1))
    first.forEach((dispose) => dispose())
    registerOrcaProfileAuthIpcBridge([])
    emitProgress(null)

    snapshots[0](WAITING)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(progress()).toBeNull()
  })
})
