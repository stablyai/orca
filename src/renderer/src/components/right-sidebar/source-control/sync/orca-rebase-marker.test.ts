import { describe, expect, it } from 'vitest'
import { orcaRebaseMarkerIsRetired } from './orca-rebase-marker'

describe('orcaRebaseMarkerIsRetired', () => {
  const marker = { branch: 'feature', upstreamOid: 'u1', state: 'done' as const }
  const noUpstreamOid = { hasUpstream: true, ahead: 0, behind: 0 }

  it('retires a done marker on a branch switch before the new upstream is known', () => {
    expect(orcaRebaseMarkerIsRetired(marker, 'other', noUpstreamOid)).toBe(true)
    expect(orcaRebaseMarkerIsRetired(marker, 'feature', noUpstreamOid)).toBe(false)
  })

  it('keeps a done marker through the paused rebase detached-HEAD reading Continue leaves behind', () => {
    expect(orcaRebaseMarkerIsRetired(marker, '', noUpstreamOid)).toBe(false)
    expect(orcaRebaseMarkerIsRetired(marker, '', undefined)).toBe(false)
  })

  it('retires an active marker on a detached HEAD, so it cannot match again on return', () => {
    expect(orcaRebaseMarkerIsRetired({ ...marker, state: 'active' }, '', noUpstreamOid)).toBe(true)
  })
})
