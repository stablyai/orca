import { describe, expect, it } from 'vitest'
import {
  EMPTY_LINEAR_ISSUE_ATTRIBUTE_FILTER,
  canonicalizeLinearIssueAttributeFilter,
  emptyLinearIssueAttributeFilter,
  isEmptyLinearIssueAttributeFilter,
  linearIssueAttributeFilterSignature,
  parseLinearIssueAttributeFilter,
  type LinearIssueAttributeFilter
} from './linear-issue-attribute-filter'

const sample: LinearIssueAttributeFilter = {
  stateIds: ['b', 'a', 'a', '  c  '],
  priorities: [3, 1, 1, 0],
  assignee: { kind: 'user', id: '  user-1  ' },
  labelIds: ['z', 'y', 'z']
}

describe('linear-issue-attribute-filter', () => {
  it('treats the canonical empty value as empty and signature-less', () => {
    expect(isEmptyLinearIssueAttributeFilter(EMPTY_LINEAR_ISSUE_ATTRIBUTE_FILTER)).toBe(true)
    expect(isEmptyLinearIssueAttributeFilter(emptyLinearIssueAttributeFilter())).toBe(true)
    expect(linearIssueAttributeFilterSignature(EMPTY_LINEAR_ISSUE_ATTRIBUTE_FILTER)).toBe('')
    expect(linearIssueAttributeFilterSignature(undefined)).toBe('')
  })

  it('canonicalizes without mutating the input and produces a stable signature', () => {
    const input = structuredClone(sample)
    const canonical = canonicalizeLinearIssueAttributeFilter(input)
    expect(input).toEqual(sample)
    expect(canonical).toEqual({
      stateIds: ['a', 'b', 'c'],
      priorities: [0, 1, 3],
      assignee: { kind: 'user', id: 'user-1' },
      labelIds: ['y', 'z']
    })
    expect(linearIssueAttributeFilterSignature(sample)).toBe(
      linearIssueAttributeFilterSignature(canonical)
    )
    expect(linearIssueAttributeFilterSignature(sample)).toContain('"priorities":[0,1,3]')
  })

  it('changes the signature when any facet changes', () => {
    const base = canonicalizeLinearIssueAttributeFilter(sample)
    expect(linearIssueAttributeFilterSignature({ ...base, stateIds: ['x'] })).not.toBe(
      linearIssueAttributeFilterSignature(base)
    )
    expect(linearIssueAttributeFilterSignature({ ...base, priorities: [4] })).not.toBe(
      linearIssueAttributeFilterSignature(base)
    )
    expect(
      linearIssueAttributeFilterSignature({ ...base, assignee: { kind: 'unassigned' } })
    ).not.toBe(linearIssueAttributeFilterSignature(base))
    expect(linearIssueAttributeFilterSignature({ ...base, labelIds: ['other'] })).not.toBe(
      linearIssueAttributeFilterSignature(base)
    )
  })

  it('preserves priority 0 and unassigned assignee', () => {
    const canonical = canonicalizeLinearIssueAttributeFilter({
      stateIds: [],
      priorities: [0],
      assignee: { kind: 'unassigned' },
      labelIds: []
    })
    expect(canonical.priorities).toEqual([0])
    expect(canonical.assignee).toEqual({ kind: 'unassigned' })
    expect(isEmptyLinearIssueAttributeFilter(canonical)).toBe(false)
  })

  it('parses valid wire input and rejects partial/unknown/malformed payloads', () => {
    expect(
      parseLinearIssueAttributeFilter({
        stateIds: ['s1'],
        priorities: [0, 2],
        assignee: { kind: 'unassigned' },
        labelIds: ['l1']
      })
    ).toEqual({
      stateIds: ['s1'],
      priorities: [0, 2],
      assignee: { kind: 'unassigned' },
      labelIds: ['l1']
    })

    expect(() => parseLinearIssueAttributeFilter({ stateIds: [] })).toThrow(/required/)
    expect(() =>
      parseLinearIssueAttributeFilter({
        stateIds: [],
        priorities: [],
        assignee: null,
        labelIds: [],
        extra: true
      })
    ).toThrow(/unknown key/)
    expect(() =>
      parseLinearIssueAttributeFilter({
        stateIds: [''],
        priorities: [],
        assignee: null,
        labelIds: []
      })
    ).toThrow(/non-empty/)
    expect(() =>
      parseLinearIssueAttributeFilter({
        stateIds: [],
        priorities: [1.5],
        assignee: null,
        labelIds: []
      })
    ).toThrow(/integer/)
    expect(() =>
      parseLinearIssueAttributeFilter({
        stateIds: [],
        priorities: [5],
        assignee: null,
        labelIds: []
      })
    ).toThrow(/0 to 4/)
    expect(() =>
      parseLinearIssueAttributeFilter({
        stateIds: [],
        priorities: [],
        assignee: { kind: 'user' },
        labelIds: []
      })
    ).toThrow(/assignee\.id/)
    expect(() =>
      parseLinearIssueAttributeFilter({
        stateIds: Array.from({ length: 101 }, (_, i) => `s${i}`),
        priorities: [],
        assignee: null,
        labelIds: []
      })
    ).toThrow(/exceeds 100/)
  })
})
