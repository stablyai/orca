import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ConnectCurrentOrcaProfileResult,
  OrcaProfileAuthStatus
} from '../../../../shared/orca-profiles'
import { createTestStore } from './store-test-helpers'

const { toastErrorMock } = vi.hoisted(() => ({
  toastErrorMock: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    error: toastErrorMock,
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn()
  }
}))

const localAuth: OrcaProfileAuthStatus = {
  activeProfileId: 'local-default',
  configured: true,
  state: 'local',
  persistence: 'none'
}

const orcaProfilesApi = {
  connectCurrent: vi.fn()
}

function deferredConnect(): (result: ConnectCurrentOrcaProfileResult) => void {
  let finish!: (result: ConnectCurrentOrcaProfileResult) => void
  orcaProfilesApi.connectCurrent.mockReturnValueOnce(
    new Promise<ConnectCurrentOrcaProfileResult>((resolve) => {
      finish = resolve
    })
  )
  return (result) => finish(result)
}

describe('orca profile sign-in timeout', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubGlobal('window', {
      api: { orcaProfiles: orcaProfilesApi }
    })
  })

  it('reports a timeout only for the newest wait', async () => {
    const finishFirst = deferredConnect()
    const finishSecond = deferredConnect()
    const store = createTestStore()

    const first = store.getState().connectCurrentOrcaProfile()
    const second = store.getState().connectCurrentOrcaProfile()
    finishFirst({ status: 'cancelled', auth: localAuth })
    await first
    expect(toastErrorMock).not.toHaveBeenCalled()

    finishSecond({ status: 'timed-out', auth: localAuth })
    await second
    expect(toastErrorMock).toHaveBeenCalledOnce()
    expect(toastErrorMock).toHaveBeenCalledWith('Sign-in timed out')
  })

  it('stays silent when the user cancels in the browser', async () => {
    orcaProfilesApi.connectCurrent.mockResolvedValueOnce({ status: 'cancelled', auth: localAuth })
    const store = createTestStore()

    await store.getState().connectCurrentOrcaProfile()

    expect(toastErrorMock).not.toHaveBeenCalled()
  })
})
