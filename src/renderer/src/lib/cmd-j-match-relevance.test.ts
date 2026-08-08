import { describe, expect, it } from 'vitest'
import {
  getOpenTabMatchRelevance,
  getWorktreeMatchRelevance,
  NO_MATCH_RELEVANCE,
  scorePaletteRelevance
} from './cmd-j-match-relevance'
import type { PaletteSearchResult } from './worktree-palette-search'
import type { Worktree } from '../../../shared/types'

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    repoId: 'repo-1',
    path: '/repos/orca/perf',
    branch: 'perf/renderer-store',
    displayName: 'perf-diff-tighten',
    lastActivityAt: 0,
    ...overrides
  } as Worktree
}

function makeMatch(overrides: Partial<PaletteSearchResult> = {}): PaletteSearchResult {
  return {
    worktreeId: 'wt-1',
    matchedField: null,
    displayNameRange: null,
    branchRange: null,
    repoRange: null,
    supportingText: null,
    ...overrides
  }
}

function makeOpenTab(
  overrides: Partial<Parameters<typeof getOpenTabMatchRelevance>[0]> = {}
): Parameters<typeof getOpenTabMatchRelevance>[0] {
  return {
    title: 'Performance Review Main Daemon',
    titleRange: null,
    secondaryText: 'docs/update-android-apk',
    secondaryRange: null,
    worktreeName: 'docs-update',
    worktreeRange: null,
    repoName: 'orca',
    repoRange: null,
    ...overrides
  }
}

describe('scorePaletteRelevance', () => {
  it('ranks whole-string, prefix, word-start, then mid-word matches', () => {
    const exact = scorePaletteRelevance([{ text: 'perf', range: { start: 0, end: 4 }, tier: 0 }])
    const prefix = scorePaletteRelevance([
      { text: 'perf-diff-tighten', range: { start: 0, end: 4 }, tier: 0 }
    ])
    const wordStart = scorePaletteRelevance([
      {
        text: 'improve-agent-dashboard-performance',
        range: { start: 24, end: 28 },
        tier: 0
      }
    ])
    const midWord = scorePaletteRelevance([
      { text: 'superperformance', range: { start: 5, end: 9 }, tier: 0 }
    ])
    expect(exact).toBeLessThan(prefix)
    expect(prefix).toBeLessThan(wordStart)
    expect(wordStart).toBeLessThan(midWord)
  })

  it('ranks any primary-field hit above the best secondary-field hit', () => {
    const worstPrimary = scorePaletteRelevance([
      { text: 'superperformance', range: { start: 5, end: 9 }, tier: 0 }
    ])
    const bestSecondary = scorePaletteRelevance([
      { text: 'perf', range: { start: 0, end: 4 }, tier: 1 }
    ])
    expect(worstPrimary).toBeLessThan(bestSecondary)
  })

  it('treats a CJK character before the match as a word boundary', () => {
    expect(
      scorePaletteRelevance([{ text: '工作树perf', range: { start: 3, end: 7 }, tier: 0 }])
    ).toBe(scorePaletteRelevance([{ text: 'aperf', range: { start: 1, end: 5 }, tier: 0 }]))
  })

  it('treats a decomposed accent before the match as mid-word, not a word boundary', () => {
    // 'cafe' + combining acute: the char before the match is a mark, not a separator
    const decomposed = scorePaletteRelevance([
      { text: 'cafe\u0301perf', range: { start: 5, end: 9 }, tier: 0 }
    ])
    expect(decomposed).toBe(
      scorePaletteRelevance([{ text: 'superperf', range: { start: 5, end: 9 }, tier: 0 }])
    )
    expect(
      scorePaletteRelevance([{ text: 'cafe-perf', range: { start: 5, end: 9 }, tier: 0 }])
    ).toBeLessThan(decomposed)
  })

  it('returns NO_MATCH_RELEVANCE when no field matched', () => {
    expect(scorePaletteRelevance([{ text: 'perf', range: null, tier: 0 }])).toBe(NO_MATCH_RELEVANCE)
    expect(scorePaletteRelevance([])).toBe(NO_MATCH_RELEVANCE)
  })

  it('takes the best field when several matched', () => {
    expect(
      scorePaletteRelevance([
        { text: 'orca', range: { start: 0, end: 4 }, tier: 2 },
        { text: 'orca-main', range: { start: 0, end: 4 }, tier: 0 }
      ])
    ).toBe(scorePaletteRelevance([{ text: 'orca-main', range: { start: 0, end: 4 }, tier: 0 }]))
  })
})

describe('getWorktreeMatchRelevance', () => {
  it('ranks a display-name prefix above a display-name word-start', () => {
    const prefix = getWorktreeMatchRelevance(
      makeMatch({
        matchedField: 'displayName',
        displayNameRange: { start: 0, end: 4 }
      }),
      makeWorktree(),
      'orca'
    )
    const wordStart = getWorktreeMatchRelevance(
      makeMatch({
        matchedField: 'displayName',
        displayNameRange: { start: 24, end: 28 }
      }),
      makeWorktree({ displayName: 'improve-agent-dashboard-performance' }),
      'orca'
    )
    expect(prefix).toBeLessThan(wordStart)
  })

  it('ranks a branch hit below any display-name hit and above a comment hit', () => {
    const branch = getWorktreeMatchRelevance(
      makeMatch({ matchedField: 'branch', branchRange: { start: 0, end: 4 } }),
      makeWorktree(),
      'orca'
    )
    const displayName = getWorktreeMatchRelevance(
      makeMatch({
        matchedField: 'displayName',
        displayNameRange: { start: 12, end: 16 }
      }),
      makeWorktree({ displayName: 'superperfxperf' }),
      'orca'
    )
    const comment = getWorktreeMatchRelevance(
      makeMatch({
        matchedField: 'comment',
        supportingText: {
          labelKind: 'comment',
          text: 'perf notes',
          matchRange: { start: 0, end: 4 }
        }
      }),
      makeWorktree(),
      'orca'
    )
    expect(displayName).toBeLessThan(branch)
    expect(branch).toBeLessThan(comment)
  })

  it('falls back to the resolved display name when displayName is unset', () => {
    expect(
      getWorktreeMatchRelevance(
        makeMatch({
          matchedField: 'displayName',
          displayNameRange: { start: 0, end: 4 }
        }),
        makeWorktree({ displayName: undefined }),
        'orca'
      )
    ).toBeLessThan(NO_MATCH_RELEVANCE)
  })
})

describe('getOpenTabMatchRelevance', () => {
  it('ranks a tab title prefix level with a worktree display-name prefix', () => {
    expect(getOpenTabMatchRelevance(makeOpenTab({ titleRange: { start: 0, end: 4 } }))).toBe(
      getWorktreeMatchRelevance(
        makeMatch({
          matchedField: 'displayName',
          displayNameRange: { start: 0, end: 4 }
        }),
        makeWorktree(),
        'orca'
      )
    )
  })

  it('ranks a tab title prefix above a worktree word-start hit', () => {
    expect(
      getOpenTabMatchRelevance(makeOpenTab({ titleRange: { start: 0, end: 4 } }))
    ).toBeLessThan(
      getWorktreeMatchRelevance(
        makeMatch({
          matchedField: 'displayName',
          displayNameRange: { start: 24, end: 28 }
        }),
        makeWorktree({ displayName: 'improve-agent-dashboard-performance' }),
        'orca'
      )
    )
  })

  it('scores the browser workspace label as ambient context', () => {
    const workspace = getOpenTabMatchRelevance(
      makeOpenTab({
        workspaceLabel: 'perf preview',
        workspaceRange: { start: 0, end: 4 }
      })
    )
    const secondary = getOpenTabMatchRelevance(
      makeOpenTab({ secondaryRange: { start: 0, end: 4 } })
    )
    expect(secondary).toBeLessThan(workspace)
  })
})
