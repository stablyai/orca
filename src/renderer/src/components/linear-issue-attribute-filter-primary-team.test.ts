import { describe, expect, it } from 'vitest'
import { resolveLinearIssueAttributeFilterPrimaryTeam } from './linear-issue-attribute-filter-primary-team'
import type { LinearTeam } from '../../../shared/types'

const teams: LinearTeam[] = [
  { id: 't-b', name: 'Backend', key: 'BE' },
  { id: 't-a', name: 'App', key: 'APP' },
  { id: 't-c', name: 'Core', key: 'CORE' }
]

describe('resolveLinearIssueAttributeFilterPrimaryTeam', () => {
  it('picks the first available team by stable name/id when none selected', () => {
    expect(
      resolveLinearIssueAttributeFilterPrimaryTeam({
        selectedTeamIds: [],
        availableTeams: teams
      })?.id
    ).toBe('t-a')
  })

  it('picks the first selected team by stable name/id order', () => {
    expect(
      resolveLinearIssueAttributeFilterPrimaryTeam({
        selectedTeamIds: ['t-c', 't-b'],
        availableTeams: teams
      })?.id
    ).toBe('t-b')
  })

  it('falls back to first available when selected ids are unavailable', () => {
    expect(
      resolveLinearIssueAttributeFilterPrimaryTeam({
        selectedTeamIds: ['missing'],
        availableTeams: teams
      })?.id
    ).toBe('t-a')
  })
})
