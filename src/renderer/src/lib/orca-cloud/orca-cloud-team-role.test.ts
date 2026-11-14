import { describe, expect, it } from 'vitest'
import type { OrcaProfileAuthStatus } from '../../../../shared/orca-profiles'
import { canManageActiveTeam } from './orca-cloud-team-role'

function status(role: string | undefined, activeOrgId = 'org-1'): OrcaProfileAuthStatus {
  return {
    activeProfileId: 'p',
    configured: true,
    state: 'connected',
    persistence: 'encrypted',
    cloud: { cloudProfileId: 'c', userId: 'u', email: 'e', activeOrgId, linkedAt: 0 },
    organizations: [
      { orgId: 'org-1', name: 'Eval', role },
      { orgId: 'org-2', name: 'Other', role: 'Owner' }
    ]
  }
}

describe('canManageActiveTeam (the console billing rule)', () => {
  it('lets owners and admins of the active team in, whatever the case', () => {
    expect(canManageActiveTeam(status('Owner'))).toBe(true)
    expect(canManageActiveTeam(status('admin'))).toBe(true)
    expect(canManageActiveTeam(status(' Admin '))).toBe(true)
  })

  it('treats members, unknown and missing roles as members', () => {
    expect(canManageActiveTeam(status('Member'))).toBe(false)
    expect(canManageActiveTeam(status('billing'))).toBe(false)
    expect(canManageActiveTeam(status(undefined))).toBe(false)
  })

  it('reads the active team only, and nothing while signed out', () => {
    expect(canManageActiveTeam(status('Member', 'org-2'))).toBe(true)
    expect(canManageActiveTeam(status('Owner', 'org-9'))).toBe(false)
    expect(canManageActiveTeam({ ...status('Owner'), state: 'reconnect-required' })).toBe(false)
    expect(canManageActiveTeam(null)).toBe(false)
  })
})
