import { describe, expect, it } from 'vitest'
import type { LinearTeam, LinearWorkspace } from '../../../shared/types'
import {
  getLinearScopeTriggerLabel,
  normalizeLinearScopeTeamSelection
} from './linear-scope-selector'

const workspaces: LinearWorkspace[] = [
  {
    id: 'workspace-1',
    organizationId: 'workspace-1',
    organizationName: 'Alpha',
    displayName: 'Ada',
    email: 'ada@example.com'
  },
  {
    id: 'workspace-2',
    organizationId: 'workspace-2',
    organizationName: 'Beta',
    displayName: 'Ada',
    email: 'ada@example.com'
  }
]

function team(
  id: string,
  key: string,
  workspaceId = 'workspace-1',
  workspaceName = 'Alpha'
): LinearTeam {
  return { id, key, name: key, workspaceId, workspaceName }
}

describe('LinearScopeSelector helpers', () => {
  it('normalizes selecting every visible team back to sticky-all', () => {
    const result = normalizeLinearScopeTeamSelection({
      teams: [team('eng', 'ENG'), team('sta', 'STA')],
      currentSelectedTeamIds: new Set(['eng']),
      nextSelectedTeamIds: new Set(['eng', 'sta'])
    })

    expect(Array.from(result.selectedTeamIds)).toEqual(['eng', 'sta'])
    expect(result.persisted).toBeNull()
  })

  it('never persists an empty team array', () => {
    const result = normalizeLinearScopeTeamSelection({
      teams: [team('eng', 'ENG')],
      currentSelectedTeamIds: new Set(['eng']),
      nextSelectedTeamIds: new Set()
    })

    expect(Array.from(result.selectedTeamIds)).toEqual(['eng'])
    expect(result.persisted).toBeNull()
  })

  it('labels sticky-all in one workspace as all teams', () => {
    expect(
      getLinearScopeTriggerLabel({
        workspaces: [workspaces[0]],
        selectedWorkspaceId: 'workspace-1',
        teams: [team('eng', 'ENG')],
        selectedTeamIds: new Set(['eng']),
        teamSelectionIsStickyAll: true
      })
    ).toBe('All teams')
  })

  it('labels multi-workspace sticky-all as all workspaces', () => {
    expect(
      getLinearScopeTriggerLabel({
        workspaces,
        selectedWorkspaceId: 'all',
        teams: [team('eng', 'ENG'), team('ops', 'OPS', 'workspace-2', 'Beta')],
        selectedTeamIds: new Set(['eng', 'ops']),
        teamSelectionIsStickyAll: true
      })
    ).toBe('All workspaces')
  })

  it('uses team counts for ambiguous all-workspace subsets', () => {
    expect(
      getLinearScopeTriggerLabel({
        workspaces,
        selectedWorkspaceId: 'all',
        teams: [
          team('eng-a', 'ENG'),
          team('eng-b', 'ENG', 'workspace-2', 'Beta'),
          team('ops', 'OPS', 'workspace-2', 'Beta')
        ],
        selectedTeamIds: new Set(['eng-a', 'eng-b']),
        teamSelectionIsStickyAll: false
      })
    ).toBe('All workspaces / 2 teams')
  })
})
