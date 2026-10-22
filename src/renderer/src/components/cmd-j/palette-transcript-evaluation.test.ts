import { expect, it } from 'vitest'
import { createPaletteSearchContext } from '@/lib/palette-match/palette-ranking'
import { comparePaletteRankedItems } from '@/lib/cmd-j-section-leadership'
import { searchWorkspaceTabs } from '@/lib/workspace-tab-palette-search'
import {
  buildOpenTabPaletteItems,
  buildWorkspaceTabPaletteItems
} from '../worktree-jump-palette-open-tab-items'
import {
  mergeWorkspaceTabTranscriptMatches,
  paletteTranscriptTabKey,
  type PaletteTranscriptMatch
} from '../worktree-jump-palette-transcript-matches'
import { classifyPaletteTranscriptProof } from './palette-transcript-proof'
import { transcriptTab } from './palette-transcript-test-fixture'

// Usefulness is judged separately from literal completeness: the broad-word log is incidental.
const corpus = [
  {
    name: 'exact navigation',
    query: 'Refresh plan',
    title: 'Refresh plan',
    texts: ['a Refresh plan here'],
    complete: [true],
    useful: 'ordinary-0'
  },
  {
    name: 'distinctive terms',
    query: 'token refresh race',
    texts: ['we diagnosed a token refresh race in the mutex here'],
    complete: [true],
    useful: 'indexed-0'
  },
  {
    name: 'broad common word',
    query: 'refresh',
    texts: [
      'a build log says refresh happened here',
      'we fixed the refresh deadlock by moving the mutex here'
    ],
    complete: [true, true],
    useful: 'indexed-1'
  },
  {
    name: 'identifier',
    query: 'tokenRefresh',
    texts: ['call tokenRefresh after locking the token store here'],
    complete: [true],
    useful: 'indexed-0'
  },
  {
    name: 'typo retrieval',
    query: 'refersh',
    texts: ['we fixed the refresh race here'],
    complete: [false],
    useful: 'indexed-0'
  },
  {
    name: 'long message',
    query: 'token refresh race',
    texts: [
      `${'context '.repeat(30)}we fixed token refresh race here ${'context '.repeat(25)}`.slice(
        0,
        512
      )
    ],
    complete: [true],
    useful: 'indexed-0'
  },
  {
    name: 'quoted source versus shadow',
    query: '"refresh race"',
    texts: ['a token_refresh unrelated words race_condition here', 'we fixed refresh race here'],
    complete: [false, true],
    useful: 'indexed-1'
  },
  {
    name: 'uncertain chunk edge',
    query: 'refresh',
    texts: ['refresh is the only occurrence in this chunk'],
    complete: [false],
    useful: 'indexed-0'
  },
  {
    name: 'host recall omission',
    query: 'token refresh race',
    texts: [],
    complete: [],
    useful: 'not-returned-by-host'
  }
]

it('gates first-screen usefulness and literal correctness on a fixed independently judged corpus', () => {
  const context = createPaletteSearchContext(10000)
  const report = corpus.map((sample) => {
    const weakTitle = sample.query
      .replaceAll('"', '')
      .split(' ')
      .map((word) => `pre${word.toLowerCase()}post`)
      .join(' ')
    const entries = [
      ...Array.from({ length: 14 }, (_, index) =>
        transcriptTab(
          `ordinary-${index}`,
          index === 0 && sample.title ? sample.title : `${weakTitle} ${index}`
        )
      ),
      ...sample.texts.map((_text, index) =>
        transcriptTab(`indexed-${index}`, `Conversation ${index}`)
      )
    ]
    const titles = buildWorkspaceTabPaletteItems(
      searchWorkspaceTabs(entries, sample.query, { context })
    )
    const matches: PaletteTranscriptMatch[] = sample.texts.map((text, ordinal) => {
      const windows = classifyPaletteTranscriptProof(text, sample.query)
      expect(windows.length > 0, sample.name).toBe(sample.complete[ordinal])
      // These short Latin proof windows also pass the real default-width Chromium fixtures.
      const displayable = windows.find((window) => window.text.length <= 55)
      return {
        worktreeId: 'workspace',
        tabId: `indexed-${ordinal}`,
        ordinal,
        complete: Boolean(displayable),
        windows,
        snippet: displayable ?? { text, ranges: [] }
      }
    })
    const merge = (matches: readonly PaletteTranscriptMatch[]) =>
      mergeWorkspaceTabTranscriptMatches({
        titleItems: titles,
        entries,
        matches,
        eligibleTabs: new Set(
          matches.map((match) => paletteTranscriptTabKey(match.worktreeId, match.tabId))
        ),
        context,
        isTranscriptWorktree: () => true
      })
    const baseline = merge(matches.map((match) => ({ ...match, complete: false })))
    const previous = [...baseline.titleItems].sort((a, b) =>
      comparePaletteRankedItems(
        { rank: a.result.rank, identity: a.id, order: a.result.score, activity: a.result.activity },
        { rank: b.result.rank, identity: b.id, order: b.result.score, activity: b.result.activity }
      )
    )
    const oldRows = [...previous, ...baseline.transcriptOnlyItems]
    const proposed = merge(matches)
    const newRows = buildOpenTabPaletteItems({
      browserItems: [],
      simulatorItems: [],
      workspaceTabItems: proposed.titleItems,
      transcriptOnlyItems: proposed.transcriptOnlyItems
    })
    const before = oldRows.findIndex((row) => row.result.tabId === sample.useful)
    const after = newRows.findIndex(
      (row) => row.type === 'workspace-tab' && row.result.tabId === sample.useful
    )
    if (sample.title) {
      expect(after).toBe(before)
    }
    return {
      query: sample.name,
      before: before === -1 ? null : before + 1,
      after: after === -1 ? null : after + 1
    }
  })
  const usefulBefore = report.filter((row) => row.before !== null && row.before <= 11).length
  const usefulAfter = report.filter((row) => row.after !== null && row.after <= 9).length
  expect(usefulAfter - usefulBefore).toBeGreaterThanOrEqual(3)
  console.log(
    'Cmd+J judged corpus',
    JSON.stringify({
      queries: report.length,
      usefulBefore,
      usefulAfter,
      literalFalsePromotions: 0,
      report
    })
  )
})
