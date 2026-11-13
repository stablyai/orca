import { describe, expect, it } from 'vitest'
import type { OrcaProfileAuthStatus } from '../../../../shared/orca-profiles'
import { activeTeamRole, isActiveTeamAdmin } from './active-team-role'

function status(patch: Partial<OrcaProfileAuthStatus> = {}): OrcaProfileAuthStatus {
  return {
    activeProfileId: 'p1',
    configured: true,
    state: 'connected',
    persistence: 'encrypted',
    cloud: {
      cloudProfileId: 'cp',
      userId: 'u1',
      email: 'a@acme.dev',
      activeOrgId: 'acme',
      linkedAt: 1
    },
    organizations: [
      { orgId: 'acme', name: 'Acme', role: 'Owner' },
      { orgId: 'globex', name: 'Globex', role: 'member' }
    ],
    ...patch
  }
}

describe('activeTeamRole', () => {
  it("reads the role in the active team, whatever case auth's provider spells it in", () => {
    expect(activeTeamRole(status())).toBe('owner')
    expect(isActiveTeamAdmin(status())).toBe(true)
    const admin = status({ organizations: [{ orgId: 'acme', name: 'Acme', role: ' ADMIN ' }] })
    expect(activeTeamRole(admin)).toBe('admin')
    expect(isActiveTeamAdmin(admin)).toBe(true)
  })

  it('is the role in the ACTIVE team, not any team the person owns', () => {
    const inGlobex = status({ cloud: { ...status().cloud!, activeOrgId: 'globex' } })
    expect(activeTeamRole(inGlobex)).toBe('member')
    expect(isActiveTeamAdmin(inGlobex)).toBe(false)
  })

  it('treats an unknown or missing role as member, never as admin', () => {
    for (const role of ['Billing manager', '', undefined]) {
      const odd = status({ organizations: [{ orgId: 'acme', name: 'Acme', role }] })
      expect(activeTeamRole(odd)).toBe('member')
      expect(isActiveTeamAdmin(odd)).toBe(false)
    }
    expect(isActiveTeamAdmin(status({ organizations: [] }))).toBe(false)
  })

  it('has no team role on a personal account, signed out, or before auth has answered', () => {
    expect(
      activeTeamRole(status({ cloud: { ...status().cloud!, activeOrgId: undefined } }))
    ).toBeNull()
    expect(activeTeamRole(status({ state: 'reconnect-required' }))).toBeNull()
    expect(activeTeamRole(null)).toBeNull()
    expect(isActiveTeamAdmin(undefined)).toBe(false)
  })
})
