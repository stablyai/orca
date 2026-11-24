import { describe, expect, it } from 'vitest'
import { orcaRebaseMarkerIsRetired, orcaRebaseMarkerMatches } from './orca-rebase-marker'

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

describe('orcaRebaseMarkerMatches', () => {
  const diverged = { hasUpstream: true, ahead: 3, behind: 3, upstreamOid: 'u1' }
  const active = { branch: 'feature', upstreamOid: 'u1', state: 'active' as const, behind: 3 }

  it('keeps matching new local commits on top of the rebase', () => {
    expect(orcaRebaseMarkerMatches(active, 'feature', { ...diverged, ahead: 5 })).toBe(true)
  })

  // An external `git reset` at the same upstream tip changes how many upstream commits are missing,
  // and the remote may now hold real work: Pull must come back instead of a force push.
  it('retires once an external reset changes the behind count at the same upstream tip', () => {
    const reset = { ...diverged, ahead: 1, behind: 7 }
    expect(orcaRebaseMarkerMatches(active, 'feature', reset)).toBe(false)
    expect(orcaRebaseMarkerIsRetired(active, 'feature', reset)).toBe(true)
  })
})
