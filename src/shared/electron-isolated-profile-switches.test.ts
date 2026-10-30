import { describe, expect, it } from 'vitest'
import {
  electronIsolatedProfileSwitches,
  foregroundServeIsolatedProfileSwitches,
  usesIsolatedProfile
} from './electron-isolated-profile-switches'

describe('isolated profile detection', () => {
  it('recognizes either half of the E2E pair', () => {
    expect(usesIsolatedProfile({ ORCA_E2E_USER_DATA_DIR: '/tmp/e2e' })).toBe(true)
    expect(usesIsolatedProfile({ ORCA_E2E_HOME_DIR: '/tmp/e2e-home' })).toBe(true)
    expect(usesIsolatedProfile({})).toBe(false)
    expect(usesIsolatedProfile({ HOME: '/tmp/e2e-home' })).toBe(false)
  })
})

describe('electronIsolatedProfileSwitches', () => {
  it('keeps the keychain out of an isolated profile', () => {
    // Fresh HOME lacks a login keychain; OSCrypt otherwise blocks readiness on an unanswered authorization prompt (#25453).
    expect(electronIsolatedProfileSwitches({ ORCA_E2E_HOME_DIR: '/tmp/e2e-home' })).toEqual([
      '--password-store=basic',
      '--use-mock-keychain'
    ])
  })

  it('leaves a normal profile on the real keychain', () => {
    expect(electronIsolatedProfileSwitches({})).toEqual([])
  })
})

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
