import { describe, expect, it } from 'vitest'
import type { LinearTeam } from '../../../shared/types'
import {
  resolveLinearIssueAttributeFilterTeamIds,
  unionLinearMetadataById
} from './linear-issue-attribute-filter-team-ids'

const teams: LinearTeam[] = [
  { id: 'team-be', name: 'Backend', key: 'BE' },
  { id: 'team-fe', name: 'Frontend', key: 'FE' },
  { id: 'team-ops', name: 'Ops', key: 'OPS' }
]

describe('resolveLinearIssueAttributeFilterTeamIds', () => {
  it('returns every selected team in stable name order', () => {
    expect(
      resolveLinearIssueAttributeFilterTeamIds({
        selectedTeamIds: ['team-fe', 'team-be'],
        availableTeams: teams,
        primaryTeamId: 'team-be'
      })
    ).toEqual(['team-be', 'team-fe'])
  })

  it('returns all selected teams when All teams is selected', () => {
    expect(
      resolveLinearIssueAttributeFilterTeamIds({
        selectedTeamIds: ['team-ops', 'team-be', 'team-fe'],
        availableTeams: teams,
        primaryTeamId: 'team-be'
      })
    ).toEqual(['team-be', 'team-fe', 'team-ops'])
  })

  it('falls back to primary when selection is empty', () => {
    expect(
      resolveLinearIssueAttributeFilterTeamIds({
        selectedTeamIds: [],
        availableTeams: teams,
        primaryTeamId: 'team-fe'
      })
    ).toEqual(['team-fe'])
  })

  it('drops ids that are not in availableTeams', () => {
    expect(
      resolveLinearIssueAttributeFilterTeamIds({
        selectedTeamIds: ['team-fe', 'missing'],
        availableTeams: teams,
        primaryTeamId: 'team-be'
      })
    ).toEqual(['team-fe'])
  })
})

describe('unionLinearMetadataById', () => {
  it('unions options across teams without dropping later teams (#8739)', () => {
    const unioned = unionLinearMetadataById([
      [
        { id: 'be-todo', name: 'Todo' },
        { id: 'be-done', name: 'Done' }
      ],
      [
        { id: 'fe-todo', name: 'Todo' },
        { id: 'fe-review', name: 'In Review' }
      ],
      [{ id: 'ops-blocked', name: 'Blocked' }]
    ])
    expect(unioned.map((row) => row.id)).toEqual([
      'be-todo',
      'be-done',
      'fe-todo',
      'fe-review',
      'ops-blocked'
    ])
  })

  it('dedupes shared ids keeping the first label', () => {
    const unioned = unionLinearMetadataById([
      [{ id: 'shared', name: 'From BE' }],
      [{ id: 'shared', name: 'From FE' }]
    ])
    expect(unioned).toEqual([{ id: 'shared', name: 'From BE' }])
  })
})
