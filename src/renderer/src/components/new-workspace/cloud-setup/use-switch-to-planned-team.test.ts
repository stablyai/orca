import { describe, expect, it } from 'vitest'
import type { OrcaProfileAuthStatus } from '../../../../../shared/orca-profiles/orca-profiles'
import { plannedTeamsFrom, teamPlanLookupIds } from './use-switch-to-planned-team'

const status = (activeOrgId?: string): OrcaProfileAuthStatus => ({
  activeProfileId: 'p',
  configured: true,
  state: 'connected',
  persistence: 'encrypted',
  cloud: {
    cloudProfileId: 'cp',
    userId: 'u1',
    email: 'alex@example.com',
    linkedAt: 1,
    ...(activeOrgId ? { activeOrgId, activeOrgName: 'acme' } : {})
  },
  organizations: [
    { orgId: 'org_acme', name: 'acme' },
    { orgId: 'org_side', name: 'side-project' },
    { orgId: 'org_lapsed', name: 'old-co' }
  ]
})

describe('teamPlanLookupIds', () => {
  it('asks only on a personal account with teams', () => {
    expect(teamPlanLookupIds(status())).toEqual(['org_acme', 'org_side', 'org_lapsed'])
    expect(teamPlanLookupIds(status('org_acme'))).toBeNull()
    expect(teamPlanLookupIds({ ...status(), organizations: [] })).toBeNull()
    expect(teamPlanLookupIds({ ...status(), state: 'reconnect-required' })).toBeNull()
    expect(teamPlanLookupIds(null)).toBeNull()
  })
})

describe('plannedTeamsFrom', () => {
  it('keeps teams on a plan that can start a sandbox, in the account menu order', () => {
    const teams = plannedTeamsFrom(status(), [
      { orgId: 'org_lapsed', plan: null, planLabel: null, canStartSandbox: false },
      { orgId: 'org_side', plan: 'team', planLabel: 'Team', canStartSandbox: false },
      { orgId: 'org_acme', plan: 'team', planLabel: 'Team', canStartSandbox: true },
      // Not in the user's org list: ignored.
      { orgId: 'org_x', plan: 'team', planLabel: 'Team', canStartSandbox: true }
    ])
    expect(teams).toEqual([{ orgId: 'org_acme', name: 'acme', planLabel: 'Team' }])
  })
})
