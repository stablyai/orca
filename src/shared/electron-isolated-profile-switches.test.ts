import { describe, expect, it } from 'vitest'
import { foregroundServeIsolatedProfileSwitches } from './electron-isolated-profile-switches'

describe('foregroundServeIsolatedProfileSwitches', () => {
  it('needs the profile itself to be isolated, not only HOME', () => {
    expect(foregroundServeIsolatedProfileSwitches({ ORCA_E2E_USER_DATA_DIR: '/tmp/e2e' })).toEqual([
      '--password-store=basic',
      '--use-mock-keychain'
    ])
    // A HOME override alone still serves the user's real profile, whose secrets need the keychain.
    expect(foregroundServeIsolatedProfileSwitches({ ORCA_E2E_HOME_DIR: '/tmp/e2e-home' })).toEqual(
      []
    )
    expect(foregroundServeIsolatedProfileSwitches({})).toEqual([])
  })
})
