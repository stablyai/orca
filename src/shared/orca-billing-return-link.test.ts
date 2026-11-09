import { describe, expect, it } from 'vitest'
import { findOrcaBillingReturnLink, parseOrcaBillingReturnLink } from './orca-billing'

describe('parseOrcaBillingReturnLink', () => {
  it('accepts only the three return outcomes', () => {
    expect(parseOrcaBillingReturnLink('orca://billing/return?checkout=success')).toEqual({
      kind: 'checkout-success'
    })
    expect(parseOrcaBillingReturnLink('orca://billing/return?checkout=cancel')).toEqual({
      kind: 'checkout-cancel'
    })
    expect(parseOrcaBillingReturnLink('orca://billing/return?portal=return')).toEqual({
      kind: 'portal'
    })
  })
  it('rejects other hosts, paths, schemes and junk', () => {
    for (const raw of [
      'orca://billing/return',
      'orca://billing/return?checkout=paid',
      'orca://evil/return?checkout=success',
      'orca://billing/other?checkout=success',
      'https://billing/return?checkout=success',
      'not a url'
    ]) {
      expect(parseOrcaBillingReturnLink(raw)).toBeNull()
    }
  })
  it('finds the link among launch arguments', () => {
    expect(
      findOrcaBillingReturnLink([
        '/Applications/Orca.app',
        '--x',
        'orca://billing/return?checkout=cancel'
      ])
    ).toEqual({ kind: 'checkout-cancel' })
    expect(findOrcaBillingReturnLink(['--flag'])).toBeNull()
  })
})
