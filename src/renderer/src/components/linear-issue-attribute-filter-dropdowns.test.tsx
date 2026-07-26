import { describe, expect, it } from 'vitest'
import {
  clearLinearIssueAttributeFacet,
  countLinearIssueAttributeFilters,
  linearIssueAttributeFilterPillLabels
} from './linear-issue-attribute-filter-sections'
import type { LinearIssueAttributeFilter } from '../../../shared/linear-issue-attribute-filter'

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
