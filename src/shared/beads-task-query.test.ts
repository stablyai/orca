import { describe, expect, it } from 'vitest'
import type { BeadsIssue } from './beads-types'
import {
  getBeadsFetchPlan,
  getBeadsPresetForQuery,
  getBeadsPresetQuery,
  hasBeadsFacetQualifiers,
  isBeadsTaskQueryFiltering,
  matchesBeadsTaskQuery,
  parseBeadsTaskQuery,
  serializeBeadsTaskQuery,
  withBeadsQualifier
} from './beads-task-query'

function makeIssue(overrides: Partial<BeadsIssue> = {}): BeadsIssue {
  return {
    id: 'orca-a1',
    title: 'Fix the flux capacitor',
    status: 'open',
    priority: 2,
    issueType: 'task',
    labels: [],
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-02T00:00:00Z',
    dependencyCount: 0,
    dependentCount: 0,
    commentCount: 0,
    ...overrides
  }
}

describe('parseBeadsTaskQuery', () => {
  it('parses statuses, ORing multiple is: tokens', () => {
    const q = parseBeadsTaskQuery('is:open is:in_progress')
    expect(q.statuses).toEqual(['open', 'in_progress'])
    expect(q.freeText).toBe('')
  })

  it('accepts is:in-progress as a spelling of in_progress and dedupes', () => {
    const q = parseBeadsTaskQuery('is:in-progress is:in_progress')
    expect(q.statuses).toEqual(['in_progress'])
  })

  it('parses issue types including is:decision', () => {
    const q = parseBeadsTaskQuery('is:decision is:bug')
    expect(q.types).toEqual(['decision', 'bug'])
    expect(q.statuses).toEqual([])
  })

  it('treats is:issue as a GitHub-parity no-op', () => {
    const q = parseBeadsTaskQuery('is:issue is:open')
    expect(q).toEqual(parseBeadsTaskQuery('is:open'))
  })

  it('parses is:ready', () => {
    const q = parseBeadsTaskQuery('is:ready')
    expect(q.ready).toBe(true)
    expect(q.statuses).toEqual([])
  })

  it('parses assignee, @me, and no:assignee', () => {
    expect(parseBeadsTaskQuery('assignee:alice').assignee).toBe('alice')
    expect(parseBeadsTaskQuery('assignee:@me').assignee).toBe('@me')
    expect(parseBeadsTaskQuery('no:assignee').noAssignee).toBe(true)
  })

  it('parses repeatable labels in order', () => {
    expect(parseBeadsTaskQuery('label:infra label:"needs review"').labels).toEqual([
      'infra',
      'needs review'
    ])
  })

  it('accepts priority as p0..p4, P0..P4, and bare 0-4', () => {
    expect(parseBeadsTaskQuery('priority:p0').priorities).toEqual([0])
    expect(parseBeadsTaskQuery('priority:P3').priorities).toEqual([3])
    expect(parseBeadsTaskQuery('priority:4 priority:1').priorities).toEqual([1, 4])
    // Out-of-range priorities fall through to free text.
    expect(parseBeadsTaskQuery('priority:p9').priorities).toEqual([])
    expect(parseBeadsTaskQuery('priority:p9').freeText).toBe('priority:p9')
  })

  it('routes unknown qualifiers and quoted phrases to free text', () => {
    const q = parseBeadsTaskQuery('milestone:v2 "flux capacitor" loose')
    expect(q.freeText).toBe('milestone:v2 "flux capacitor" loose')
    expect(q.freeTextTerms).toEqual(['milestone:v2', 'flux capacitor', 'loose'])
  })

  it('round-trips through serializeBeadsTaskQuery', () => {
    for (const raw of [
      'is:open',
      'is:open is:in_progress',
      'is:ready',
      'is:decision priority:p1 assignee:@me',
      'is:closed label:infra label:"needs review" no:assignee',
      'is:bug "flux capacitor" milestone:v2'
    ]) {
      const parsed = parseBeadsTaskQuery(raw)
      expect(parseBeadsTaskQuery(serializeBeadsTaskQuery(parsed))).toEqual(parsed)
    }
  })
})

describe('withBeadsQualifier', () => {
  it('patches one facet while preserving the rest of the query', () => {
    const next = withBeadsQualifier('is:open flux label:infra', 'statuses', ['closed', 'blocked'])
    const parsed = parseBeadsTaskQuery(next)
    expect(parsed.statuses).toEqual(['blocked', 'closed'])
    expect(parsed.labels).toEqual(['infra'])
    expect(parsed.freeText).toBe('flux')
  })

  it('maps priority strings and drops invalid ones', () => {
    const parsed = parseBeadsTaskQuery(withBeadsQualifier('', 'priorities', ['0', 'p2', 'nope']))
    expect(parsed.priorities).toEqual([0, 2])
  })

  it('setting an assignee clears no:assignee; null clears the assignee', () => {
    const withAssignee = withBeadsQualifier('no:assignee', 'assignee', 'alice')
    expect(parseBeadsTaskQuery(withAssignee)).toMatchObject({
      assignee: 'alice',
      noAssignee: false
    })
    expect(parseBeadsTaskQuery(withBeadsQualifier(withAssignee, 'assignee', null)).assignee).toBe(
      null
    )
  })

  it('quotes values containing whitespace', () => {
    expect(withBeadsQualifier('', 'labels', ['needs review'])).toBe('label:"needs review"')
  })
})

describe('preset queries', () => {
  it('maps each preset to its query and back', () => {
    expect(getBeadsPresetQuery('open')).toBe('is:open')
    expect(getBeadsPresetQuery('assigned')).toBe('is:open assignee:@me')
    expect(getBeadsPresetQuery('ready')).toBe('is:ready')
    for (const preset of ['open', 'assigned', 'ready'] as const) {
      expect(getBeadsPresetForQuery(getBeadsPresetQuery(preset))).toBe(preset)
    }
  })

  it('matches semantically equal queries regardless of token order', () => {
    expect(getBeadsPresetForQuery('assignee:@me is:open')).toBe('assigned')
    expect(getBeadsPresetForQuery('is:issue is:open')).toBe('open')
  })

  it('returns null for anything narrower or broader', () => {
    expect(getBeadsPresetForQuery('is:open label:infra')).toBeNull()
    expect(getBeadsPresetForQuery('is:closed')).toBeNull()
    expect(getBeadsPresetForQuery('')).toBeNull()
  })
})

describe('getBeadsFetchPlan', () => {
  it('routes is:ready to the bd-ready scope', () => {
    expect(getBeadsFetchPlan(parseBeadsTaskQuery('is:ready'))).toEqual({
      statusScope: 'ready',
      assignee: null,
      legacyPreset: 'ready'
    })
  })

  it('needs --all when is:closed is present or no status tokens exist', () => {
    expect(getBeadsFetchPlan(parseBeadsTaskQuery('is:closed')).statusScope).toBe('all')
    expect(getBeadsFetchPlan(parseBeadsTaskQuery('is:open is:closed')).statusScope).toBe('all')
    expect(getBeadsFetchPlan(parseBeadsTaskQuery('flux')).statusScope).toBe('all')
    expect(getBeadsFetchPlan(parseBeadsTaskQuery('')).statusScope).toBe('all')
  })

  it('stays on the default open-ish list for non-closed status sets', () => {
    expect(getBeadsFetchPlan(parseBeadsTaskQuery('is:open')).statusScope).toBe('open')
    expect(getBeadsFetchPlan(parseBeadsTaskQuery('is:blocked is:deferred')).statusScope).toBe(
      'open'
    )
  })

  it('carries the assignee and picks the closest legacy preset', () => {
    expect(getBeadsFetchPlan(parseBeadsTaskQuery('is:open assignee:@me'))).toEqual({
      statusScope: 'open',
      assignee: '@me',
      legacyPreset: 'assigned'
    })
    expect(getBeadsFetchPlan(parseBeadsTaskQuery('is:open assignee:alice'))).toEqual({
      statusScope: 'open',
      assignee: 'alice',
      legacyPreset: 'open'
    })
  })
})

describe('matchesBeadsTaskQuery', () => {
  it('ORs statuses and types, ANDs labels', () => {
    const q = parseBeadsTaskQuery('is:open is:blocked label:a label:b')
    expect(matchesBeadsTaskQuery(makeIssue({ status: 'blocked', labels: ['a', 'b'] }), q)).toBe(
      true
    )
    expect(matchesBeadsTaskQuery(makeIssue({ status: 'closed', labels: ['a', 'b'] }), q)).toBe(
      false
    )
    expect(matchesBeadsTaskQuery(makeIssue({ labels: ['a'] }), q)).toBe(false)
  })

  it('filters type, priority, and no:assignee', () => {
    const q = parseBeadsTaskQuery('is:decision priority:p0 no:assignee')
    expect(matchesBeadsTaskQuery(makeIssue({ issueType: 'decision', priority: 0 }), q)).toBe(true)
    expect(matchesBeadsTaskQuery(makeIssue({ issueType: 'decision', priority: 1 }), q)).toBe(false)
    expect(
      matchesBeadsTaskQuery(makeIssue({ issueType: 'decision', priority: 0, assignee: 'alice' }), q)
    ).toBe(false)
  })

  it('matches a specific assignee but leaves @me to the fetch', () => {
    expect(
      matchesBeadsTaskQuery(makeIssue({ assignee: 'alice' }), parseBeadsTaskQuery('assignee:alice'))
    ).toBe(true)
    expect(
      matchesBeadsTaskQuery(makeIssue({ assignee: 'bob' }), parseBeadsTaskQuery('assignee:alice'))
    ).toBe(false)
    expect(matchesBeadsTaskQuery(makeIssue(), parseBeadsTaskQuery('assignee:@me'))).toBe(true)
  })

  it('substring-matches every free-text term over id, title, and labels', () => {
    const issue = makeIssue({ id: 'orca-42', title: 'Flux capacitor', labels: ['infra'] })
    expect(matchesBeadsTaskQuery(issue, parseBeadsTaskQuery('flux infra'))).toBe(true)
    expect(matchesBeadsTaskQuery(issue, parseBeadsTaskQuery('"flux capacitor"'))).toBe(true)
    expect(matchesBeadsTaskQuery(issue, parseBeadsTaskQuery('"capacitor flux"'))).toBe(false)
    expect(matchesBeadsTaskQuery(issue, parseBeadsTaskQuery('orca-42'))).toBe(true)
  })
})

describe('query activity helpers', () => {
  it('isBeadsTaskQueryFiltering counts qualifiers and free text but not is:ready', () => {
    expect(isBeadsTaskQueryFiltering(parseBeadsTaskQuery(''))).toBe(false)
    expect(isBeadsTaskQueryFiltering(parseBeadsTaskQuery('is:ready'))).toBe(false)
    expect(isBeadsTaskQueryFiltering(parseBeadsTaskQuery('is:open'))).toBe(true)
    expect(isBeadsTaskQueryFiltering(parseBeadsTaskQuery('flux'))).toBe(true)
    expect(isBeadsTaskQueryFiltering(parseBeadsTaskQuery('no:assignee'))).toBe(true)
  })

  it('hasBeadsFacetQualifiers ignores free text and is:ready', () => {
    expect(hasBeadsFacetQualifiers(parseBeadsTaskQuery('is:ready flux'))).toBe(false)
    expect(hasBeadsFacetQualifiers(parseBeadsTaskQuery('label:infra'))).toBe(true)
  })
})
