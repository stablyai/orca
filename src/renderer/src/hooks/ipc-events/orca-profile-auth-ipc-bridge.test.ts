import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaCloudSignInProgress } from '../../../../shared/orca-profiles'
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

  it('lets a newer change win over a late snapshot', async () => {
    registerOrcaProfileAuthIpcBridge([])
    await vi.waitFor(() => expect(snapshots).toHaveLength(1))
    emitProgress(null)
    snapshots[0](WAITING)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(progress()).toBeNull()
  })
})
