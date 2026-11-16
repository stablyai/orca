import { describe, expect, it } from 'vitest'
import {
  emptyLinearIssueAttributeFilter,
  LINEAR_ISSUE_ATTRIBUTE_FILTER_ID_MAX_LENGTH,
  type LinearIssueAttributeFilter
} from './issue-attribute-filter'
import {
  defaultLinearIssueViewResumeState,
  LINEAR_DISPLAY_PROPERTIES,
  normalizeLinearIssueViewResumeState,
  resolveLinearIssueViewResumeState,
  selectLinearWorkspaceIssueFilter,
  serializeLinearIssueViewResumeState,
  setLinearWorkspaceIssueFilter
} from './issue-view-resume-state'

function filter(overrides: Partial<LinearIssueAttributeFilter> = {}): LinearIssueAttributeFilter {
  return { ...emptyLinearIssueAttributeFilter(), ...overrides }
}

const FILTER_A = filter({ stateIds: ['state-a'], priorities: [1] })
const FILTER_B = filter({ labelIds: ['label-b'], assignee: { kind: 'user', id: 'user-b' } })

describe('resolveLinearIssueViewResumeState', () => {
  it('keeps an empty display-property list, which means every property is hidden', () => {
    expect(resolveLinearIssueViewResumeState({ displayProperties: [] }).displayProperties).toEqual(
      []
    )
  })
})

describe('normalizeLinearIssueViewResumeState', () => {
  it('keeps the valid fields when only some of them are corrupt', () => {
    const normalized = normalizeLinearIssueViewResumeState({
      viewMode: 'board',
      groupBy: 'nonsense',
      orderBy: 'updated',
      teamPropertyTouched: 'yes'
    })

    expect(normalized).toEqual({
      viewMode: 'board',
      groupBy: 'none',
      orderBy: 'updated',
      displayProperties: [...LINEAR_DISPLAY_PROPERTIES],
      teamPropertyTouched: false,
      filtersByWorkspaceId: {}
    })
  })

  it('drops only the corrupt workspace filter and keeps the healthy ones', () => {
    const normalized = normalizeLinearIssueViewResumeState({
      viewMode: 'board',
      filtersByWorkspaceId: {
        'workspace-a': FILTER_A,
        'workspace-broken': { stateIds: 'not-an-array' },
        'workspace-partial': { stateIds: ['state-x'] },
        '': FILTER_B
      }
    })

    expect(normalized?.viewMode).toBe('board')
    expect(normalized?.filtersByWorkspaceId).toEqual({ 'workspace-a': FILTER_A })
  })

  it('drops empty persisted filters and a __proto__ workspace key', () => {
    // JSON.parse (unlike an object literal) makes __proto__ an own key, which is how it would arrive from disk.
    const normalized = normalizeLinearIssueViewResumeState({
      viewMode: 'board',
      filtersByWorkspaceId: JSON.parse(
        `{"workspace-empty": ${JSON.stringify(emptyLinearIssueAttributeFilter())},
          "__proto__": ${JSON.stringify(FILTER_A)}}`
      )
    })

    expect(normalized?.filtersByWorkspaceId).toEqual({})
    expect(({} as Record<string, unknown>).stateIds).toBeUndefined()
  })
})

describe('serializeLinearIssueViewResumeState', () => {
  // Overlength IDs can make a nonempty filter empty only after bounding.
  it('omits a filter that only becomes empty once bounded', () => {
    const serialized = serializeLinearIssueViewResumeState({
      ...defaultLinearIssueViewResumeState(),
      filtersByWorkspaceId: {
        'workspace-over-length': filter({
          labelIds: ['x'.repeat(LINEAR_ISSUE_ATTRIBUTE_FILTER_ID_MAX_LENGTH + 1)]
        })
      }
    })

    expect(serialized.filtersByWorkspaceId).toEqual({})
    expect(normalizeLinearIssueViewResumeState(serialized)).toBeUndefined()
  })
})

describe('selectLinearWorkspaceIssueFilter', () => {
  const filters = { 'workspace-a': FILTER_A, 'workspace-b': FILTER_B }

  it('retrieves only the selected workspace filter', () => {
    expect(selectLinearWorkspaceIssueFilter(filters, 'workspace-a')).toEqual(FILTER_A)
    expect(selectLinearWorkspaceIssueFilter(filters, 'workspace-b')).toEqual(FILTER_B)
  })

  it('never applies another workspace filter while Linear is unresolved or disconnected', () => {
    expect(selectLinearWorkspaceIssueFilter(filters, null)).toEqual(
      emptyLinearIssueAttributeFilter()
    )
    // Why: an unresolved workspace must read as unfiltered without erasing anything.
    expect(filters).toEqual({ 'workspace-a': FILTER_A, 'workspace-b': FILTER_B })
  })

  it('ignores inherited object keys', () => {
    expect(selectLinearWorkspaceIssueFilter(filters, 'toString')).toEqual(
      emptyLinearIssueAttributeFilter()
    )
  })
})

describe('setLinearWorkspaceIssueFilter', () => {
  it('keeps workspace filters independent across A -> B -> A', () => {
    let filters: Record<string, LinearIssueAttributeFilter> = {}
    filters = setLinearWorkspaceIssueFilter(filters, 'workspace-a', FILTER_A)
    expect(selectLinearWorkspaceIssueFilter(filters, 'workspace-a')).toEqual(FILTER_A)

    // Switching to B shows B's (empty) filter without touching A's.
    expect(selectLinearWorkspaceIssueFilter(filters, 'workspace-b')).toEqual(
      emptyLinearIssueAttributeFilter()
    )
    filters = setLinearWorkspaceIssueFilter(filters, 'workspace-b', FILTER_B)

    expect(selectLinearWorkspaceIssueFilter(filters, 'workspace-a')).toEqual(FILTER_A)
    expect(selectLinearWorkspaceIssueFilter(filters, 'workspace-b')).toEqual(FILTER_B)
  })

  it('removes the entry when the filter is cleared and leaves other workspaces alone', () => {
    let filters = setLinearWorkspaceIssueFilter({}, 'workspace-a', FILTER_A)
    filters = setLinearWorkspaceIssueFilter(filters, 'workspace-b', FILTER_B)

    filters = setLinearWorkspaceIssueFilter(
      filters,
      'workspace-a',
      emptyLinearIssueAttributeFilter()
    )

    expect(filters).toEqual({ 'workspace-b': FILTER_B })
  })

  it('refuses an unusable workspace key', () => {
    const filters = { 'workspace-a': FILTER_A }

    expect(setLinearWorkspaceIssueFilter(filters, '__proto__', FILTER_B)).toBe(filters)
    expect(setLinearWorkspaceIssueFilter(filters, '', FILTER_B)).toBe(filters)
  })
})
