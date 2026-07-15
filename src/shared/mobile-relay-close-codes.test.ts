import { describe, expect, it } from 'vitest'
import {
  isMobileRelayCloseCode,
  MOBILE_RELAY_CLOSE_CODE,
  mobileRelayRecoveryFor
} from './mobile-relay-close-codes'

describe('mobile relay close-code contract', () => {
  it('locks all application close codes', () => {
    expect(MOBILE_RELAY_CLOSE_CODE).toEqual({
      BAD_OUTER_CREDENTIAL: 4401,
      HOST_OFFLINE: 4404,
      PEER_DROPPED: 4408,
      WRONG_CELL: 4409,
      LIMIT_EXCEEDED: 4429,
      DRAINING: 4503
    })
    expect(isMobileRelayCloseCode(4409)).toBe(true)
    expect(isMobileRelayCloseCode(1006)).toBe(false)
  })

  it('uses the configured director and never a cell-supplied URL', () => {
    expect(mobileRelayRecoveryFor(4503, 'host-control')).toEqual({
      kind: 'resolve-configured-director',
      fullJitter: true
    })
  })

  it('separates invite and resume wrong-cell recovery', () => {
    expect(mobileRelayRecoveryFor(4409, 'phone-invite')).toEqual({
      kind: 'resolve-invite-through-director-ws',
      requireStrictlyNewerEpoch: true
    })
    expect(mobileRelayRecoveryFor(4409, 'phone-resume')).toEqual({
      kind: 'resolve-resume-through-director-post'
    })
  })

  it('keeps outer credential failure endpoint-scoped', () => {
    expect(mobileRelayRecoveryFor(4401, 'phone-resume')).toEqual({
      kind: 'disable-relay-credential',
      directUnaffected: true
    })
  })
})
