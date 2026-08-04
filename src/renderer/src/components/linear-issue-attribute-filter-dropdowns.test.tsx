// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LinearIssueAttributeFilterDropdowns from './linear-issue-attribute-filter-dropdowns'
import {
  clearLinearIssueAttributeFacet,
  countLinearIssueAttributeFilters,
  linearIssueAttributeFilterPillLabels
} from './linear-issue-attribute-filter-sections'
import type { LinearIssueAttributeFilter } from '../../../shared/linear-issue-attribute-filter'

const metadataMocks = vi.hoisted(() => ({
  useTeamsStates: vi.fn(),
  useTeamsLabels: vi.fn(),
  useTeamsMembers: vi.fn()
}))

vi.mock('@/hooks/useIssueMetadata', () => metadataMocks)

afterEach(cleanup)

const sample: LinearIssueAttributeFilter = {
  stateIds: ['s1', 's2'],
  priorities: [0, 1],
  assignee: { kind: 'unassigned' },
  labelIds: ['l1']
}

describe('linear-issue-attribute-filter helpers', () => {
  it('counts active facets and clears individual facets', () => {
    expect(countLinearIssueAttributeFilters(sample)).toBe(4)
    expect(clearLinearIssueAttributeFacet(sample, 'status').stateIds).toEqual([])
    expect(clearLinearIssueAttributeFacet(sample, 'priority').priorities).toEqual([])
    expect(clearLinearIssueAttributeFacet(sample, 'assignee').assignee).toBeNull()
    expect(clearLinearIssueAttributeFacet(sample, 'labels').labelIds).toEqual([])
  })

  it('builds pill labels from metadata maps', () => {
    const pills = linearIssueAttributeFilterPillLabels({
      value: sample,
      stateNamesById: new Map([
        ['s1', 'Todo'],
        ['s2', 'In Progress']
      ]),
      memberNamesById: new Map(),
      labelNamesById: new Map([['l1', 'Bug']])
    })
    expect(pills.map((p) => p.key)).toEqual(['status', 'priority', 'assignee', 'labels'])
    expect(pills[0]?.value).toContain('Todo')
    expect(pills[2]?.value).toMatch(/Unassigned/i)
    expect(pills[3]?.value).toBe('Bug')
  })
})

describe('LinearIssueAttributeFilterDropdowns', () => {
  it('keeps an active filter label resolved while the dropdown is closed', () => {
    metadataMocks.useTeamsStates.mockReturnValue({ data: [], loading: false, error: null })
    metadataMocks.useTeamsLabels.mockImplementation((teamIds: string[]) => ({
      data: teamIds.length > 0 ? [{ id: 'label-1', name: 'Bug' }] : [],
      loading: false,
      error: null
    }))
    metadataMocks.useTeamsMembers.mockReturnValue({ data: [], loading: false, error: null })

    const team = { id: 'team-1', name: 'Engineering', key: 'ENG' }
    render(
      <LinearIssueAttributeFilterDropdowns
        value={{ stateIds: [], priorities: [], assignee: null, labelIds: ['label-1'] }}
        onChange={vi.fn()}
        workspaceId="workspace-1"
        isAllWorkspaces={false}
        primaryTeam={team}
        selectedTeamIds={[team.id]}
        availableTeams={[team]}
      />
    )

    expect(screen.getByText('Bug')).toBeTruthy()
    expect(screen.queryByText('label-1')).toBeNull()
  })
})
