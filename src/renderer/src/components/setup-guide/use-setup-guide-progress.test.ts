import { describe, expect, it } from 'vitest'
import { getComputerUsePermissionSetupState } from './use-setup-guide-progress'

describe('getComputerUsePermissionSetupState', () => {
  it('does not treat a failed status read as unavailable setup completion', () => {
    expect(getComputerUsePermissionSetupState(null)).toEqual({
      ready: false,
      unavailable: false
    })
  })

  it('marks Computer Use ready only when permissions are granted and helper is available', () => {
    expect(
      getComputerUsePermissionSetupState({
        platform: 'darwin',
        helperAppPath: '/Applications/Orca Helper.app',
        helperUnavailableReason: null,
        permissions: [
          { id: 'accessibility', status: 'granted' },
          { id: 'screenshots', status: 'granted' }
        ]
      })
    ).toEqual({ ready: true, unavailable: false })
  })

  it('marks Computer Use unavailable only for explicit helper unavailability', () => {
    expect(
      getComputerUsePermissionSetupState({
        platform: 'linux',
        helperAppPath: null,
        helperUnavailableReason: 'unsupported-platform',
        permissions: []
      })
    ).toEqual({ ready: false, unavailable: true })
  })
})
