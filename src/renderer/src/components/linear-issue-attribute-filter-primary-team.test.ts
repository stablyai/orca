import { describe, expect, it } from 'vitest'
import { resolveLinearIssueAttributeFilterPrimaryTeam } from './linear-issue-attribute-filter-primary-team'
import type { LinearTeam } from '../../../shared/linear/workspace-types'

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

it('selects a primary team without pairwise membership checks or sorting all teams', () => {
  let reads = 0
  let nameReads = 0
  const availableTeams = Array.from({ length: 1000 }, (_, index) => ({
    id: `team-${index}`,
    key: String(index),
    get name() {
      nameReads += 1
      return String((index * 173) % 1000).padStart(4, '0')
    }
  }))
  const selectedTeamIds = new Proxy(
    availableTeams.map((team) => team.id),
    {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) {
          reads += 1
        }
        return Reflect.get(target, key, receiver)
      }
    }
  )
  expect(resolveLinearIssueAttributeFilterPrimaryTeam({ selectedTeamIds, availableTeams })).toBe(
    availableTeams[0]
  )
  expect(reads).toBeLessThanOrEqual(1000)
  expect(nameReads).toBeLessThan(5000)
})
