import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaCloudSignInEnd, OrcaCloudSignInProgress } from '../../../../shared/orca-profiles'
import { createTestStore } from '../../store/testing/app-store-test-fixture'

type TestStore = ReturnType<typeof createTestStore>

const { storeHolder } = vi.hoisted((): { storeHolder: { current: TestStore | null } } => ({
  storeHolder: { current: null }
}))

vi.mock('../../store', () => ({
  useAppStore: {
    getState: () => storeHolder.current?.getState(),
    setState: (partial: {
      orcaProfileSignInProgress: OrcaCloudSignInProgress | null
      orcaProfileSignInEnd?: OrcaCloudSignInEnd | null
    }) => storeHolder.current?.setState(partial)
  }
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() }
}))

import { registerOrcaProfileAuthIpcBridge } from './orca-profile-auth-ipc-bridge'

describe('orca profile sign-in progress IPC bridge', () => {
  let emitProgress: (
    progress: OrcaCloudSignInProgress | null,
    end?: OrcaCloudSignInEnd | null
  ) => void
  const snapshots: ((progress: OrcaCloudSignInProgress | null) => void)[] = []
  const WAITING = { link: 'https://login.example/authorize?state=a' }

  beforeEach(() => {
    snapshots.length = 0
    storeHolder.current = createTestStore()
    vi.stubGlobal('window', {
      api: {
        orcaProfiles: {
          onSignInProgressChanged: (
            callback: (
              progress: OrcaCloudSignInProgress | null,
              end?: OrcaCloudSignInEnd | null
            ) => void
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

  it('keeps the timed-out note until the next sign-in starts', () => {
    registerOrcaProfileAuthIpcBridge([])
    const end = (): OrcaCloudSignInEnd | null =>
      storeHolder.current?.getState().orcaProfileSignInEnd ?? null
    emitProgress(WAITING, null)
    emitProgress(null, 'timed-out')
    expect(progress()).toBeNull()
    expect(end()).toBe('timed-out')
    emitProgress({ link: null }, null)
    expect(end()).toBeNull()
  })
})
