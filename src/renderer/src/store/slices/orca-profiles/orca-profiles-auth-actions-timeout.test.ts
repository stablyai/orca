import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ConnectCurrentOrcaProfileResult,
  OrcaProfileAuthStatus
} from '../../../../../shared/orca-profiles'
import { registerSignInNotice } from '@/lib/orca-cloud/sign-in-notice-visibility'
import { createTestStore } from '../../testing/app-store-test-fixture'

const { toastMock } = vi.hoisted(() => {
  const toastMock = Object.assign(vi.fn(), {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn()
  })
  return { toastMock }
})

vi.mock('sonner', () => ({ toast: toastMock }))

const signedOut: OrcaProfileAuthStatus = {
  activeProfileId: 'local-default',
  configured: true,
  state: 'local',
  persistence: 'none'
}
const timedOut: ConnectCurrentOrcaProfileResult = { status: 'timed-out', auth: signedOut }
const connectCurrent = vi.fn()

describe('a sign-in that times out', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubGlobal('window', { api: { orcaProfiles: { connectCurrent } } })
    connectCurrent.mockResolvedValue(timedOut)
  })

  it('says so calmly in a toast when no inline notice is on screen', async () => {
    const store = createTestStore()
    await store.getState().connectCurrentOrcaProfile()
    expect(toastMock).toHaveBeenCalledWith('Sign-in didn’t finish. Try again.')
    expect(toastMock.error).not.toHaveBeenCalled()
  })

  it('leaves it to the inline notice when one is on screen', async () => {
    const unregister = registerSignInNotice()
    try {
      const store = createTestStore()
      await store.getState().connectCurrentOrcaProfile()
      expect(toastMock).not.toHaveBeenCalled()
      expect(toastMock.error).not.toHaveBeenCalled()
    } finally {
      unregister()
    }
  })
})
