import { describe, expect, it } from 'vitest'
import type { LinearTeam } from '../../../../shared/types'
import {
  TEAM_MULTI_COMBOBOX_QUERY_MAX_BYTES,
  filterTeamMultiComboboxTeams,
  isTeamMultiComboboxQueryTooLarge
} from './team-multi-combobox'

function team(overrides: Partial<LinearTeam>): LinearTeam {
  return {
    id: 'team-1',
    key: 'ENG',
    name: 'Engineering',
    workspaceId: 'workspace-1',
    workspaceName: 'Workspace',
    ...overrides
  }
}

describe('filterTeamMultiComboboxTeams', () => {
  it('returns all teams for empty queries', () => {
    const teams = [team({ id: 'eng' }), team({ id: 'ops', key: 'OPS', name: 'Operations' })]

    expect(filterTeamMultiComboboxTeams(teams, '')).toBe(teams)
    expect(filterTeamMultiComboboxTeams(teams, '   ')).toBe(teams)
  })

  it('matches team names and keys case-insensitively', () => {
    const teams = [team({ id: 'eng' }), team({ id: 'ops', key: 'OPS', name: 'Operations' })]

    expect(filterTeamMultiComboboxTeams(teams, 'ops')).toEqual([teams[1]])
    expect(filterTeamMultiComboboxTeams(teams, 'ENGINEER')).toEqual([teams[0]])
  })

  it('rejects oversized pasted queries before reading teams', () => {
    const oversizedQuery = 'secret-team-combobox'.repeat(TEAM_MULTI_COMBOBOX_QUERY_MAX_BYTES)
    const teams = [
      {
        id: 'secret',
        workspaceId: 'workspace-1',
        get name(): string {
          throw new Error('oversized team combobox queries must not scan names')
        },
        get key(): string {
          throw new Error('oversized team combobox queries must not scan keys')
        }
      }
    ] as LinearTeam[]

    expect(isTeamMultiComboboxQueryTooLarge(oversizedQuery)).toBe(true)
    expect(filterTeamMultiComboboxTeams(teams, oversizedQuery)).toEqual([])
  })

  it('rejects oversized whitespace before trimming', () => {
    const teams = [team({ id: 'eng' })]

    expect(
      filterTeamMultiComboboxTeams(teams, ' '.repeat(TEAM_MULTI_COMBOBOX_QUERY_MAX_BYTES + 1))
    ).toEqual([])
  })
})
