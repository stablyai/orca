import { describe, expect, it } from 'vitest'
import {
  electronIsolatedProfileSwitches,
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
    // Without these the fresh HOME has no login keychain, and Chromium's OSCrypt waits on the
    // authorization prompt it raises before anything is advertised (#25453).
    expect(electronIsolatedProfileSwitches({ ORCA_E2E_HOME_DIR: '/tmp/e2e-home' })).toEqual([
      '--password-store=basic',
      '--use-mock-keychain'
    ])
  })

  it('leaves a normal profile on the real keychain', () => {
    expect(electronIsolatedProfileSwitches({})).toEqual([])
  })
})
