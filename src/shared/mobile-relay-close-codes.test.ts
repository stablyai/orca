import { describe, expect, it } from 'vitest'
import { isMobileRelayCloseCode, mobileRelayRecoveryFor } from './mobile-relay-close-codes'

describe('mobile relay close-code contract', () => {
  it('recognizes relay application codes and rejects unrelated websocket codes', () => {
    for (const code of [4401, 4404, 4408, 4409, 4429, 4503]) {
      expect(isMobileRelayCloseCode(code)).toBe(true)
    }
    for (const code of [1000, 1006, 4400, 4504]) {
      expect(isMobileRelayCloseCode(code)).toBe(false)
    }
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

  it('keeps host-offline recovery self-healing', () => {
    expect(mobileRelayRecoveryFor(4404, 'phone-resume')).toEqual({
      kind: 'retry-after-host-offline',
      fullJitter: true
    })
  })
})
