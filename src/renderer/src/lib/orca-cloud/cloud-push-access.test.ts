import { describe, expect, it } from 'vitest'
import { cloudPushAccess } from './cloud-push-access'

const admin = { admin: true, ownerType: 'Organization' } as const
const orgMember = { admin: false, ownerType: 'Organization' } as const
const notOwner = { admin: false, ownerType: 'User' } as const

describe('cloudPushAccess (ENV-NOTICE-ACTIONS)', () => {
  it("someone else's public repository (octocat/Hello-World) can't be installed on", () => {
    expect(cloudPushAccess('public', notOwner)).toBe('cantInstall')
    expect(cloudPushAccess('public', orgMember)).toBe('cantInstall')
    // gh couldn't tell: no Install unless it's known to work.
    expect(cloudPushAccess('public', null)).toBe('cantInstall')
  })

  it('an admin of the owner can install, public or not', () => {
    expect(cloudPushAccess('public', admin)).toBe('install')
    expect(cloudPushAccess('public', { admin: true, ownerType: 'User' })).toBe('install')
    expect(cloudPushAccess('missing', admin)).toBe('install')
  })

  it('missing: the control plane minted an install page; only a personal repo’s non-owner is stuck', () => {
    // An org member's install becomes a request for an owner (D2).
    expect(cloudPushAccess('missing', orgMember)).toBe('install')
    expect(cloudPushAccess('missing', null)).toBe('install')
    expect(cloudPushAccess('missing', notOwner)).toBe('cantInstall')
  })

  it('requested, granted, no answer yet, and no answer at all', () => {
    expect(cloudPushAccess('requested', null)).toBe('requested')
    expect(cloudPushAccess('granted', null)).toBe('granted')
    expect(cloudPushAccess(undefined, null)).toBe('checking')
    expect(cloudPushAccess(null, null)).toBe('unknown')
  })
})
