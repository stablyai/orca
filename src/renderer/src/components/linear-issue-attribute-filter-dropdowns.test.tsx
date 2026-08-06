// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LinearTeam } from '../../../shared/types'
import {
  clearLinearIssueAttributeFacet,
  countLinearIssueAttributeFilters,
  linearIssueAttributeFilterPillLabels
} from './linear-issue-attribute-filter-sections'
import type { LinearIssueAttributeFilter } from '../../../shared/linear-issue-attribute-filter'
import LinearIssueAttributeFilterDropdowns from './linear-issue-attribute-filter-dropdowns'

const metadataMocks = vi.hoisted(() => ({
  useTeamsStates: vi.fn((teamIds: readonly string[]) => ({
    data: teamIds.length > 0 ? [{ id: 'state-1', name: 'Todo' }] : [],
    loading: false,
    error: null
  })),
  useTeamsLabels: vi.fn((teamIds: readonly string[]) => ({
    data: teamIds.length > 0 ? [{ id: 'label-1', name: 'Bug' }] : [],
    loading: false,
    error: null
  })),
  useTeamsMembers: vi.fn((teamIds: readonly string[]) => ({
    data: teamIds.length > 0 ? [{ id: 'member-1', displayName: 'Ada Lovelace' }] : [],
    loading: false,
    error: null
  }))
}))

vi.mock('@/hooks/useIssueMetadata', () => metadataMocks)

const roots: Root[] = []

afterEach(() => {
  roots.splice(0).forEach((root) => {
    act(() => root.unmount())
  })
  document.body.replaceChildren()
  metadataMocks.useTeamsStates.mockClear()
  metadataMocks.useTeamsLabels.mockClear()
  metadataMocks.useTeamsMembers.mockClear()
})

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
  it('keeps metadata lazy while closed with only static filter labels', () => {
    const team: LinearTeam = { id: 'team-1', name: 'Engineering', key: 'ENG' }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    act(() => {
      root.render(
        <LinearIssueAttributeFilterDropdowns
          value={{
            stateIds: [],
            priorities: [1],
            assignee: { kind: 'unassigned' },
            labelIds: []
          }}
          onChange={() => undefined}
          workspaceId="workspace-1"
          isAllWorkspaces={false}
          primaryTeam={team}
          selectedTeamIds={[]}
          availableTeams={[team]}
        />
      )
    })

    expect(metadataMocks.useTeamsStates).toHaveBeenCalledWith([], undefined, null)
    expect(metadataMocks.useTeamsLabels).toHaveBeenCalledWith([], undefined, null)
    expect(metadataMocks.useTeamsMembers).toHaveBeenCalledWith([], undefined, null)
  })

  it('keeps readable metadata names available after the popover closes', () => {
    const value: LinearIssueAttributeFilter = {
      stateIds: ['state-1'],
      priorities: [],
      assignee: { kind: 'user', id: 'member-1' },
      labelIds: ['label-1']
    }
    const team: LinearTeam = { id: 'team-1', name: 'Engineering', key: 'ENG' }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    act(() => {
      root.render(
        <LinearIssueAttributeFilterDropdowns
          value={value}
          onChange={() => undefined}
          workspaceId="workspace-1"
          isAllWorkspaces={false}
          primaryTeam={team}
          selectedTeamIds={[]}
          availableTeams={[team]}
        />
      )
    })

    expect(container.textContent).toContain('Todo')
    expect(container.textContent).toContain('Ada Lovelace')
    expect(container.textContent).toContain('Bug')
    expect(container.textContent).not.toContain('state-1')
    expect(metadataMocks.useTeamsStates).toHaveBeenCalledWith(['team-1'], undefined, 'workspace-1')
    expect(metadataMocks.useTeamsLabels).toHaveBeenCalledWith(['team-1'], undefined, 'workspace-1')
    expect(metadataMocks.useTeamsMembers).toHaveBeenCalledWith(['team-1'], undefined, 'workspace-1')
  })
})
