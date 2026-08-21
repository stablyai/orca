import { describe, expect, it } from 'vitest'

import {
  getDefaultPresetForGitHubTaskKind,
  getGitHubTaskKind,
  isPRFocusedTaskView,
  normalizeGitHubTaskPreset,
  scopeGitHubTaskSearch
} from './task-page-github-task-kind'

describe('isPRFocusedTaskView', () => {
  const presetCases = [
    { preset: 'prs' as const, expected: true },
    { preset: 'my-prs' as const, expected: true },
    { preset: 'review' as const, expected: true },
    { preset: 'issues' as const, expected: false },
    { preset: 'my-issues' as const, expected: false },
    { preset: 'all' as const, expected: false },
    { preset: null, expected: false }
  ]

  for (const { preset, expected } of presetCases) {
    it(`returns ${expected} for preset ${preset ?? 'null'} with an empty query`, () => {
      expect(isPRFocusedTaskView(preset, '')).toBe(expected)
    })
  }

  const queryCases = [
    { query: 'is:pr', expected: true },
    { query: 'is:pull-request', expected: true },
    { query: 'is:merged', expected: true },
    { query: 'is:draft', expected: true },
    { query: 'review-requested:@me', expected: true },
    { query: 'reviewed-by:octocat', expected: true },
    { query: 'is:issue is:open', expected: false },
    { query: 'assignee:@me', expected: false },
    { query: 'flaky login', expected: false },
    // characterization: current behavior — is:issue plus is:pr widens scope to
    // 'all', which is not PR-focused on its own.
    { query: 'is:issue is:pr', expected: false }
  ]

  for (const { query, expected } of queryCases) {
    it(`returns ${expected} for query "${query}" on the issues preset`, () => {
      expect(isPRFocusedTaskView('issues', query)).toBe(expected)
    })
  }
})

describe('normalizeGitHubTaskPreset', () => {
  const cases = [
    { input: null, expected: 'issues' },
    { input: undefined, expected: 'issues' },
    { input: 'all' as const, expected: 'issues' },
    { input: 'issues' as const, expected: 'issues' },
    { input: 'my-issues' as const, expected: 'my-issues' },
    { input: 'prs' as const, expected: 'prs' },
    { input: 'my-prs' as const, expected: 'my-prs' },
    { input: 'review' as const, expected: 'review' }
  ]

  for (const { input, expected } of cases) {
    it(`maps ${String(input)} to ${expected}`, () => {
      expect(normalizeGitHubTaskPreset(input)).toBe(expected)
    })
  }
})

describe('getGitHubTaskKind', () => {
  it('reports prs when the preset is PR-focused', () => {
    expect(getGitHubTaskKind('review', '')).toBe('prs')
  })

  it('reports prs when only the query is PR-focused', () => {
    expect(getGitHubTaskKind('issues', 'is:pr is:open')).toBe('prs')
  })

  it('reports issues otherwise', () => {
    expect(getGitHubTaskKind(null, 'is:issue is:open')).toBe('issues')
  })
})

describe('getDefaultPresetForGitHubTaskKind', () => {
  it('maps prs to the prs preset', () => {
    expect(getDefaultPresetForGitHubTaskKind('prs')).toBe('prs')
  })

  it('maps issues to the issues preset', () => {
    expect(getDefaultPresetForGitHubTaskKind('issues')).toBe('issues')
  })
})

describe('scopeGitHubTaskSearch', () => {
  it('falls back to the kind default preset query when the input is blank', () => {
    expect(scopeGitHubTaskSearch('', 'issues')).toBe('is:issue is:open')
    expect(scopeGitHubTaskSearch('   ', 'prs')).toBe('is:pr is:open')
  })

  const alreadyScoped = ['is:pr is:open', 'is:issue label:bug', 'IS:PR is:open', 'is:pull-request']
  for (const query of alreadyScoped) {
    it(`leaves "${query}" untouched apart from trimming`, () => {
      expect(scopeGitHubTaskSearch(` ${query} `, 'issues')).toBe(query)
    })
  }

  it('prefixes is:issue when the caller kind is issues', () => {
    expect(scopeGitHubTaskSearch('login bug', 'issues')).toBe('is:issue login bug')
  })

  it('prefixes is:pr when the caller kind is prs', () => {
    expect(scopeGitHubTaskSearch('login bug', 'prs')).toBe('is:pr login bug')
  })

  it('lets a parsed pr scope override the caller kind', () => {
    // characterization: current behavior — `is:draft` implies a pr scope, so the
    // issues kind is overridden even though no literal is:pr token is present.
    expect(scopeGitHubTaskSearch('is:draft', 'issues')).toBe('is:pr is:draft')
  })

  it('keeps the caller kind when the parsed scope stays all', () => {
    // `no:assignee` sets no scope, so nothing overrides the caller kind.
    expect(scopeGitHubTaskSearch('no:assignee', 'prs')).toBe('is:pr no:assignee')
  })

  it('lets a parsed issue scope override the caller kind', () => {
    // characterization: quoting hides `is:issue` from the literal-scope regex but
    // not from the tokenizer, so the parsed issue scope beats the prs caller kind.
    expect(scopeGitHubTaskSearch('is:"issue"', 'prs')).toBe('is:issue is:"issue"')
  })

  it('re-prefixes a merged-state query with the caller kind', () => {
    // characterization: current behavior — `is:merged` sets state, not scope, so
    // the caller kind decides the prefix.
    expect(scopeGitHubTaskSearch('is:merged', 'prs')).toBe('is:pr is:merged')
  })
})
