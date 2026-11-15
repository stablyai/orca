// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearTeam } from '../../../shared/linear/workspace-types'

import {
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

describe('LinearIssueAttributeFilterDropdowns transport-cap coverage notice', () => {
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
})

// Exactly the cap is complete here; bounded ids alone cannot prove that truncation happened.
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

  // Keep intended equal to applied so only the truncation record catches unrelated-facet re-capping erasing a prior warning.
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
