import { describe, expect, it } from 'vitest'
import type { OrcaProfileAuthStatus } from '../../../../shared/orca-profiles'
import { isSignedOutOfOrcaCloud } from './LandingCloudSignInCard'

const auth = (
  configured: boolean,
  state: OrcaProfileAuthStatus['state']
): OrcaProfileAuthStatus => ({ activeProfileId: 'default', configured, state, persistence: 'none' })

describe('isSignedOutOfOrcaCloud', () => {
  it('holds in a cloud build when never signed in or the session ended', () => {
    expect(isSignedOutOfOrcaCloud(true, auth(true, 'local'))).toBe(true)
    expect(isSignedOutOfOrcaCloud(true, auth(true, 'reconnect-required'))).toBe(true)
  })

  it('does not hold when signed in', () => {
    expect(isSignedOutOfOrcaCloud(true, auth(true, 'connected'))).toBe(false)
  })

  it('does not hold in a local build or before either answer arrives', () => {
    expect(isSignedOutOfOrcaCloud(false, auth(true, 'local'))).toBe(false)
    expect(isSignedOutOfOrcaCloud(null, auth(true, 'local'))).toBe(false)
    expect(isSignedOutOfOrcaCloud(true, auth(false, 'unconfigured'))).toBe(false)
    expect(isSignedOutOfOrcaCloud(true, null)).toBe(false)
  })
})
