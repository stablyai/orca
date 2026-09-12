// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearTeam } from '../../../shared/linear/workspace-types'
import {
  clearLinearIssueAttributeFacet,
  countLinearIssueAttributeFilters,
  linearIssueAttributeFilterPillLabels
} from './linear-issue-attribute-filter-pills'
import {
  LINEAR_ISSUE_ATTRIBUTE_FILTER_MAX_LABEL_IDS,
  LINEAR_ISSUE_ATTRIBUTE_FILTER_MAX_STATE_IDS,
  type LinearIssueAttributeFilter
} from '../../../shared/linear/issue-attribute-filter'
import { TooltipProvider } from '@/components/ui/tooltip'
import LinearIssueAttributeFilterDropdowns from './linear-issue-attribute-filter-dropdowns'

const metadataMocks = vi.hoisted(() => ({
  useTeamsStates: vi.fn(),
  useTeamsLabels: vi.fn(),
  useTeamsMembers: vi.fn()
}))

vi.mock('@/hooks/useIssueMetadata', () => metadataMocks)

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const defaultStates = (teamIds: readonly string[]): unknown => ({
  data: teamIds.length > 0 ? [{ id: 'state-1', name: 'Todo' }] : [],
  loading: false,
  error: null
})
const defaultLabels = (teamIds: readonly string[]): unknown => ({
  data: teamIds.length > 0 ? [{ id: 'label-1', name: 'Bug' }] : [],
  loading: false,
  error: null
})
const defaultMembers = (teamIds: readonly string[]): unknown => ({
  data: teamIds.length > 0 ? [{ id: 'member-1', displayName: 'Ada Lovelace' }] : [],
  loading: false,
  error: null
})

const roots: Root[] = []

beforeEach(() => {
  metadataMocks.useTeamsStates.mockImplementation(defaultStates)
  metadataMocks.useTeamsLabels.mockImplementation(defaultLabels)
  metadataMocks.useTeamsMembers.mockImplementation(defaultMembers)
})

afterEach(() => {
  roots.splice(0).forEach((root) => {
    act(() => root.unmount())
  })
  document.body.replaceChildren()
  metadataMocks.useTeamsStates.mockReset()
  metadataMocks.useTeamsLabels.mockReset()
  metadataMocks.useTeamsMembers.mockReset()
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

  // Why: Linear workflow states are per team, so every team owns its own "Todo" id (#16785).
  it('collapses same-named status ids into one pill label', () => {
    const pills = linearIssueAttributeFilterPillLabels({
      value: { stateIds: ['be-todo', 'fe-todo'], priorities: [], assignee: null, labelIds: [] },
      stateNamesById: new Map([
        ['be-todo', 'Todo'],
        ['fe-todo', 'Todo']
      ]),
      memberNamesById: new Map(),
      labelNamesById: new Map(),
      statusOptions: [{ key: 'be-todo', primary: 'Todo', ids: ['be-todo', 'fe-todo'] }],
      labelOptions: [],
      statusTruncated: false,
      labelsTruncated: false
    })
    expect(pills[0]?.value).toBe('Todo')
  })

  it('builds pill labels from metadata maps', () => {
    const pills = linearIssueAttributeFilterPillLabels({
      value: sample,
      stateNamesById: new Map([
        ['s1', 'Todo'],
        ['s2', 'In Progress']
      ]),
      memberNamesById: new Map(),
      labelNamesById: new Map([['l1', 'Bug']]),
      statusOptions: [],
      labelOptions: [],
      statusTruncated: false,
      labelsTruncated: false
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
          primaryTeam={team}
          selectedTeamIds={[]}
          availableTeams={[team]}
          teamsSettled
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
          primaryTeam={team}
          selectedTeamIds={[]}
          availableTeams={[team]}
          teamsSettled
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

  // Why: filters are stored per workspace, so with no single workspace resolved a
  // click would be silently dropped — show the picker hint instead of the sections.
  it.each([['all'], [null]])(
    'offers the workspace picker hint instead of filter sections for workspaceId %s',
    (workspaceId) => {
      const team: LinearTeam = { id: 'team-1', name: 'Engineering', key: 'ENG' }
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      roots.push(root)

      act(() => {
        root.render(
          <LinearIssueAttributeFilterDropdowns
            value={{ stateIds: [], priorities: [], assignee: null, labelIds: [] }}
            onChange={() => undefined}
            workspaceId={workspaceId}
            primaryTeam={team}
            selectedTeamIds={[]}
            availableTeams={[team]}
            teamsSettled
          />
        )
      })

      const trigger = container.querySelector('button')
      act(() => {
        trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      expect(document.body.textContent).toContain('Select one workspace')
      expect(metadataMocks.useTeamsStates).toHaveBeenCalledWith([], undefined, null)
    }
  )

  // Why: restored filters render before the team fetch settles, when availableTeams is
  // still the issue-scraped subset — pruning there deletes another team's facets for good.
  it('prunes unknown facet ids only once teams settle on the mounted component', () => {
    const team: LinearTeam = { id: 'team-1', name: 'Engineering', key: 'ENG' }
    const onChange = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    const renderWith = (teamsSettled: boolean): void => {
      act(() => {
        root.render(
          <LinearIssueAttributeFilterDropdowns
            value={{
              stateIds: ['state-from-another-team'],
              priorities: [],
              assignee: null,
              labelIds: []
            }}
            onChange={onChange}
            workspaceId="workspace-1"
            primaryTeam={team}
            selectedTeamIds={[]}
            availableTeams={[team]}
            teamsSettled={teamsSettled}
          />
        )
      })
    }

    renderWith(false)
    expect(onChange).not.toHaveBeenCalled()

    renderWith(true)
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ stateIds: [], labelIds: [], assignee: null })
    )
  })
})

const multiTeamStates = [
  { id: 'be-backlog', name: 'Backlog', type: 'backlog' },
  { id: 'be-todo', name: 'Todo', type: 'unstarted' },
  { id: 'fe-backlog', name: 'Backlog', type: 'backlog' },
  { id: 'fe-todo', name: 'Todo', type: 'unstarted' }
]

const teamBe: LinearTeam = { id: 'team-be', name: 'Backend', key: 'BE' }
const teamFe: LinearTeam = { id: 'team-fe', name: 'Frontend', key: 'FE' }

function renderDropdowns(value: LinearIssueAttributeFilter): {
  rerender: (next: LinearIssueAttributeFilter) => void
  onChange: ReturnType<typeof vi.fn>
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  const onChange = vi.fn()

  const rerender = (next: LinearIssueAttributeFilter): void => {
    act(() => {
      root.render(
        // The app mounts one provider at its root; the pill's partial marker needs it.
        <TooltipProvider>
          <LinearIssueAttributeFilterDropdowns
            value={next}
            onChange={onChange}
            workspaceId="workspace-1"
            primaryTeam={teamBe}
            selectedTeamIds={['team-be', 'team-fe']}
            availableTeams={[teamBe, teamFe]}
            teamsSettled
          />
        </TooltipProvider>
      )
    })
  }

  rerender(value)
  const trigger = container.querySelector('button')
  act(() => {
    trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  return { rerender, onChange }
}

// A section button carries its label plus its selection summary, so match on the label.
function openSectionNamed(label: string): void {
  const sectionButton = [...document.body.querySelectorAll('button')].find((button) =>
    button.textContent?.trim().startsWith(label)
  )
  act(() => {
    sectionButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const emptyFilter: LinearIssueAttributeFilter = {
  stateIds: [],
  priorities: [],
  assignee: null,
  labelIds: []
}

function pickerRowsNamed(name: string): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].filter(
    (row) => row.textContent?.trim() === name
  )
}

// Why: two teams share Linear's default state template, so the picker used to list
// "Todo"/"Backlog" once per team and each row filtered to a single team's issues (#16785).
describe('LinearIssueAttributeFilterDropdowns status options across teams', () => {
  it('lists one row per status name instead of one per team state id', () => {
    metadataMocks.useTeamsStates.mockImplementation(() => ({
      data: multiTeamStates,
      loading: false,
      error: null
    }))

    renderDropdowns(emptyFilter)
    openSectionNamed('Status')

    expect(pickerRowsNamed('Todo')).toHaveLength(1)
    expect(pickerRowsNamed('Backlog')).toHaveLength(1)
  })

  it('selects every team state id behind the picked status name', () => {
    metadataMocks.useTeamsStates.mockImplementation(() => ({
      data: multiTeamStates,
      loading: false,
      error: null
    }))
    const { onChange } = renderDropdowns(emptyFilter)
    openSectionNamed('Status')
    act(() => {
      pickerRowsNamed('Todo')[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ stateIds: ['be-todo', 'fe-todo'] })
    )
  })

  // Why: "All teams" in a large workspace expands one status into an id per team, and the
  // IPC parser rejects a filter over the transport cap instead of trimming it.
  it('keeps the expanded status selection within the transport id cap', () => {
    const overCap = LINEAR_ISSUE_ATTRIBUTE_FILTER_MAX_STATE_IDS + 20
    metadataMocks.useTeamsStates.mockImplementation(() => ({
      data: Array.from({ length: overCap }, (_unused, index) => ({
        id: `team-${index}-todo`,
        name: 'Todo',
        type: 'unstarted'
      })),
      loading: false,
      error: null
    }))
    const { onChange } = renderDropdowns(emptyFilter)
    openSectionNamed('Status')
    act(() => {
      pickerRowsNamed('Todo')[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onChange.mock.calls[0]?.[0].stateIds).toHaveLength(
      LINEAR_ISSUE_ATTRIBUTE_FILTER_MAX_STATE_IDS
    )
  })
})

function sameNamedMetadata(name: string, count: number): { id: string; name: string }[] {
  return Array.from({ length: count }, (_unused, index) => ({ id: `team-${index}-${name}`, name }))
}

// Why: the bound keeps the row checked (any surviving id maps back to it), so without a
// notice the picker claims team coverage the filter never had (#16879).
describe('LinearIssueAttributeFilterDropdowns transport-cap coverage notice', () => {
  it('reports the team statuses left out once a picked status exceeds the id cap', () => {
    const overCap = LINEAR_ISSUE_ATTRIBUTE_FILTER_MAX_STATE_IDS + 20
    metadataMocks.useTeamsStates.mockImplementation(() => ({
      data: sameNamedMetadata('todo', overCap),
      loading: false,
      error: null
    }))

    const { rerender, onChange } = renderDropdowns(emptyFilter)
    openSectionNamed('Status')
    act(() => {
      pickerRowsNamed('todo')[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const bounded = onChange.mock.calls[0]?.[0] as LinearIssueAttributeFilter
    expect(bounded.stateIds).toHaveLength(LINEAR_ISSUE_ATTRIBUTE_FILTER_MAX_STATE_IDS)
    rerender(bounded)

    expect(pickerRowsNamed('todo')).toHaveLength(1)
    expect(document.body.textContent).toContain(
      `Filtering ${LINEAR_ISSUE_ATTRIBUTE_FILTER_MAX_STATE_IDS} of ${overCap} team statuses`
    )
  })

  it('reports the shrunken coverage of a picked status when a second status is added', () => {
    const perStatus = LINEAR_ISSUE_ATTRIBUTE_FILTER_MAX_STATE_IDS + 20
    metadataMocks.useTeamsStates.mockImplementation(() => ({
      data: [...sameNamedMetadata('todo', perStatus), ...sameNamedMetadata('doing', perStatus)],
      loading: false,
      error: null
    }))

    const { rerender, onChange } = renderDropdowns(emptyFilter)
    openSectionNamed('Status')
    act(() => {
      pickerRowsNamed('todo')[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    rerender(onChange.mock.calls[0]?.[0] as LinearIssueAttributeFilter)
    act(() => {
      pickerRowsNamed('doing')[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    rerender(onChange.mock.calls[1]?.[0] as LinearIssueAttributeFilter)

    expect(document.body.textContent).toContain(
      `Filtering ${LINEAR_ISSUE_ATTRIBUTE_FILTER_MAX_STATE_IDS} of ${perStatus * 2} team statuses`
    )
  })

  it('stays silent while every team id behind the picked status is applied', () => {
    metadataMocks.useTeamsStates.mockImplementation(() => ({
      data: multiTeamStates,
      loading: false,
      error: null
    }))

    const { rerender, onChange } = renderDropdowns(emptyFilter)
    openSectionNamed('Status')
    act(() => {
      pickerRowsNamed('Todo')[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    rerender(onChange.mock.calls[0]?.[0] as LinearIssueAttributeFilter)

    expect(document.body.textContent).not.toContain('team statuses')
    openSectionNamed('Back')
    expect(document.body.textContent).not.toContain('partial')
  })

  // Why: the notice only exists inside the detail panel, but the surfaces a user works from
  // after applying a filter are the collapsed section menu and the pill (#16879).
  it('flags the trimmed status filter in the section menu and the pill', () => {
    const overCap = LINEAR_ISSUE_ATTRIBUTE_FILTER_MAX_STATE_IDS + 20
    metadataMocks.useTeamsStates.mockImplementation(() => ({
      data: sameNamedMetadata('todo', overCap),
      loading: false,
      error: null
    }))

    const { rerender, onChange } = renderDropdowns(emptyFilter)
    openSectionNamed('Status')
    act(() => {
      pickerRowsNamed('todo')[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    rerender(onChange.mock.calls[0]?.[0] as LinearIssueAttributeFilter)
    openSectionNamed('Back')

    // The marker sits outside the truncating summary span, so it is its own text node.
    expect(document.body.textContent).toContain('1 selected')
    expect(document.body.textContent).toContain('· partial')
    // Why: the marker has to be reachable by keyboard and named for a screen reader,
    // which a bare title attribute never was (#17342).
    const pillMarkers = [...document.body.querySelectorAll('button')].filter(
      (button) => button.textContent === 'partial'
    )
    expect(pillMarkers).toHaveLength(1)
    expect(pillMarkers[0]?.getAttribute('data-slot')).toBe('tooltip-trigger')
  })

  // Why: the canonical id list is sorted before the cap slices it, so a picked row whose ids
  // all sort last used to vanish outright — unchecked, uncounted, and with no notice at all.
  it('keeps and counts a picked status whose ids all sort past the cap', () => {
    const cap = LINEAR_ISSUE_ATTRIBUTE_FILTER_MAX_STATE_IDS
    metadataMocks.useTeamsStates.mockImplementation(() => ({
      data: [
        ...Array.from({ length: cap }, (_unused, index) => ({
          id: `a-${String(index).padStart(3, '0')}`,
          name: 'Alpha'
        })),
        { id: 'z-000', name: 'Zeta' }
      ],
      loading: false,
      error: null
    }))

    const { rerender, onChange } = renderDropdowns(emptyFilter)
    openSectionNamed('Status')
    act(() => {
      pickerRowsNamed('Alpha')[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    rerender(onChange.mock.calls[0]?.[0] as LinearIssueAttributeFilter)
    act(() => {
      pickerRowsNamed('Zeta')[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const bounded = onChange.mock.calls[1]?.[0] as LinearIssueAttributeFilter
    rerender(bounded)

    expect(bounded.stateIds).toHaveLength(cap)
    expect(bounded.stateIds).toContain('z-000')
    expect(document.body.textContent).toContain(`Filtering ${cap} of ${cap + 1} team statuses`)
  })

  // Why: with more single-id status rows than the cap, the row the user clicks cannot fit at
  // all — the picker used to check nothing and still report full coverage (#17342).
  it('says the status filter is full instead of claiming coverage it cannot have', () => {
    const cap = LINEAR_ISSUE_ATTRIBUTE_FILTER_MAX_STATE_IDS
    const states = Array.from({ length: cap + 1 }, (_unused, index) => ({
      id: `s-${String(index).padStart(3, '0')}`,
      name: `Status ${String(index).padStart(3, '0')}`
    }))
    metadataMocks.useTeamsStates.mockImplementation(() => ({
      data: states,
      loading: false,
      error: null
    }))

    const { rerender, onChange } = renderDropdowns({
      ...emptyFilter,
      stateIds: states.slice(0, cap).map((state) => state.id)
    })
    openSectionNamed('Status')
    act(() => {
      pickerRowsNamed(`Status ${String(cap).padStart(3, '0')}`)[0]?.dispatchEvent(
        new MouseEvent('click', { bubbles: true })
      )
    })

    const bounded = onChange.mock.calls[0]?.[0] as LinearIssueAttributeFilter
    expect(bounded.stateIds).toHaveLength(cap)
    rerender(bounded)

    expect(document.body.textContent).toContain(
      `Filtering the most this can carry: ${cap} team statuses`
    )
    openSectionNamed('Back')
    expect(document.body.textContent).toContain(`${cap} selected`)
    expect(document.body.textContent).toContain('· partial')
  })

  it('reports the team labels left out once a picked label exceeds the id cap', () => {
    const overCap = LINEAR_ISSUE_ATTRIBUTE_FILTER_MAX_LABEL_IDS + 20
    metadataMocks.useTeamsLabels.mockImplementation(() => ({
      data: sameNamedMetadata('bug', overCap),
      loading: false,
      error: null
    }))

    const { rerender, onChange } = renderDropdowns(emptyFilter)
    openSectionNamed('Labels')
    act(() => {
      pickerRowsNamed('bug')[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const bounded = onChange.mock.calls[0]?.[0] as LinearIssueAttributeFilter
    expect(bounded.labelIds).toHaveLength(LINEAR_ISSUE_ATTRIBUTE_FILTER_MAX_LABEL_IDS)
    rerender(bounded)

    expect(document.body.textContent).toContain(
      `Filtering ${LINEAR_ISSUE_ATTRIBUTE_FILTER_MAX_LABEL_IDS} of ${overCap} team labels`
    )
  })
})

// Why: 20 teams x 5 status names expands to exactly the cap, so nothing is dropped — the
// warning used to fire anyway because it inferred truncation from the bounded ids (STA-5996).
describe('LinearIssueAttributeFilterDropdowns coverage at exactly the transport id cap', () => {
  const cap = LINEAR_ISSUE_ATTRIBUTE_FILTER_MAX_STATE_IDS
  const statusNames = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon']
  const capFillingStates = statusNames.flatMap((name, nameIndex) =>
    Array.from({ length: cap / statusNames.length }, (_unused, teamIndex) => ({
      id: `t${teamIndex}-${nameIndex}`,
      name
    }))
  )

  const rowNamed = (index: number): string => `Row ${String(index).padStart(3, '0')}`

  function clickRow(name: string): void {
    act(() => {
      pickerRowsNamed(name)[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }

  it('stays silent for a complete selection sitting exactly on the id cap', () => {
    metadataMocks.useTeamsStates.mockImplementation(() => ({
      data: capFillingStates,
      loading: false,
      error: null
    }))

    const { rerender, onChange } = renderDropdowns(emptyFilter)
    openSectionNamed('Status')
    statusNames.forEach((name, index) => {
      clickRow(name)
      rerender(onChange.mock.calls[index]?.[0] as LinearIssueAttributeFilter)
    })

    const bounded = onChange.mock.calls[statusNames.length - 1]?.[0] as LinearIssueAttributeFilter
    expect(bounded.stateIds).toHaveLength(cap)
    expect(document.body.textContent).not.toContain('Filtering the most this can carry')
    openSectionNamed('Back')
    expect(document.body.textContent).toContain(`${statusNames.length} selected`)
    expect(document.body.textContent).not.toContain('partial')
  })

  // Why: the prune effect only ever removes ids and never re-expands, so a recorded trim
  // that outlived its selection would keep warning about a filter that now fits.
  it('drops the recorded truncation once the selection fits again', () => {
    const states = Array.from({ length: cap + 1 }, (_unused, index) => ({
      id: `s-${String(index).padStart(3, '0')}`,
      name: rowNamed(index)
    }))
    metadataMocks.useTeamsStates.mockImplementation(() => ({
      data: states,
      loading: false,
      error: null
    }))

    const { rerender, onChange } = renderDropdowns({
      ...emptyFilter,
      stateIds: states.slice(0, cap).map((state) => state.id)
    })
    openSectionNamed('Status')
    clickRow(rowNamed(cap))
    rerender(onChange.mock.calls[0]?.[0] as LinearIssueAttributeFilter)
    expect(document.body.textContent).toContain('Filtering the most this can carry')

    clickRow(rowNamed(0))
    rerender(onChange.mock.calls[1]?.[0] as LinearIssueAttributeFilter)
    clickRow(rowNamed(cap))
    const refitted = onChange.mock.calls[2]?.[0] as LinearIssueAttributeFilter
    rerender(refitted)

    expect(refitted.stateIds).toHaveLength(cap)
    expect(refitted.stateIds).not.toContain('s-000')
    expect(document.body.textContent).not.toContain('Filtering the most this can carry')
    openSectionNamed('Back')
    expect(document.body.textContent).not.toContain('partial')
  })

  // Why: every facet change re-caps every facet, and re-capping an already-capped status is a
  // no-op — recomputing the record there would see requested === applied and erase the warning.
  // The scenario has to sit where intended === applied, or the value-derived shortfall covers
  // for the record and the guard goes untested.
  it('keeps the status truncation when an unrelated facet is picked', () => {
    const states = Array.from({ length: cap + 1 }, (_unused, index) => ({
      id: `s-${String(index).padStart(3, '0')}`,
      name: rowNamed(index)
    }))
    metadataMocks.useTeamsStates.mockImplementation(() => ({
      data: states,
      loading: false,
      error: null
    }))

    const { rerender, onChange } = renderDropdowns({
      ...emptyFilter,
      stateIds: states.slice(0, cap).map((state) => state.id)
    })
    openSectionNamed('Status')
    clickRow(rowNamed(cap))
    rerender(onChange.mock.calls[0]?.[0] as LinearIssueAttributeFilter)
    expect(document.body.textContent).toContain('Filtering the most this can carry')

    openSectionNamed('Back')
    openSectionNamed('Priority')
    clickRow('Urgent')
    const withPriority = onChange.mock.calls[1]?.[0] as LinearIssueAttributeFilter
    rerender(withPriority)

    expect(withPriority.priorities).toEqual([1])
    expect(withPriority.stateIds).toHaveLength(cap)
    openSectionNamed('Back')
    expect(document.body.textContent).toContain('· partial')
    openSectionNamed('Status')
    expect(document.body.textContent).toContain('Filtering the most this can carry')
  })

  it('keeps the labels truncation when an unrelated facet is picked', () => {
    const labelCap = LINEAR_ISSUE_ATTRIBUTE_FILTER_MAX_LABEL_IDS
    const labels = Array.from({ length: labelCap + 1 }, (_unused, index) => ({
      id: `l-${String(index).padStart(3, '0')}`,
      name: rowNamed(index)
    }))
    metadataMocks.useTeamsLabels.mockImplementation(() => ({
      data: labels,
      loading: false,
      error: null
    }))

    const { rerender, onChange } = renderDropdowns({
      ...emptyFilter,
      labelIds: labels.slice(0, labelCap).map((label) => label.id)
    })
    openSectionNamed('Labels')
    clickRow(rowNamed(labelCap))
    rerender(onChange.mock.calls[0]?.[0] as LinearIssueAttributeFilter)
    expect(document.body.textContent).toContain('Filtering the most this can carry')

    openSectionNamed('Back')
    openSectionNamed('Priority')
    clickRow('Urgent')
    const withPriority = onChange.mock.calls[1]?.[0] as LinearIssueAttributeFilter
    rerender(withPriority)

    expect(withPriority.labelIds).toHaveLength(labelCap)
    openSectionNamed('Back')
    openSectionNamed('Labels')
    expect(document.body.textContent).toContain('Filtering the most this can carry')
  })

  // Why: clearing a facet must clear its recorded trim too, or the next selection inherits
  // a warning it never earned.
  it('drops the recorded truncation when the facet is cleared', () => {
    const states = Array.from({ length: cap + 1 }, (_unused, index) => ({
      id: `s-${String(index).padStart(3, '0')}`,
      name: rowNamed(index)
    }))
    metadataMocks.useTeamsStates.mockImplementation(() => ({
      data: states,
      loading: false,
      error: null
    }))

    const { rerender, onChange } = renderDropdowns({
      ...emptyFilter,
      stateIds: states.slice(0, cap).map((state) => state.id)
    })
    openSectionNamed('Status')
    clickRow(rowNamed(cap))
    rerender(onChange.mock.calls[0]?.[0] as LinearIssueAttributeFilter)
    expect(document.body.textContent).toContain('Filtering the most this can carry')

    rerender(emptyFilter)
    clickRow(rowNamed(0))
    rerender(onChange.mock.calls[1]?.[0] as LinearIssueAttributeFilter)

    expect(document.body.textContent).not.toContain('Filtering the most this can carry')
    openSectionNamed('Back')
    expect(document.body.textContent).not.toContain('partial')
  })
})
