import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  buildWorktreeComparator,
  buildWorktreeSortLabels,
  compareWorktreeSortLabel,
  getWorktreeSortLabel,
  type SortBy
} from './smart-sort'

/** The comparator as it read before labels were precomputed. */
function legacyCompareWorktreeSortLabel(a: Worktree, b: Worktree): number {
  return getWorktreeSortLabel(a).localeCompare(getWorktreeSortLabel(b))
}

const TRICKY_LABELS: readonly (string | null)[] = [
  'alpha',
  'Alpha',
  'ALPHA',
  'álpha',
  'Álpha',
  'ångström',
  'Ångström',
  'béta',
  'Beta',
  'straße',
  'strasse',
  '🎉 party',
  '🍎 apple',
  'apple',
  '日本語',
  'にほんご',
  '한국어',
  'Ω omega',
  'ω omega',
  'task-2',
  'task-10',
  'task-02',
  'TASK-2',
  'task_2',
  'task 2',
  '  leading space',
  'trailing space  ',
  '',
  '   ',
  null,
  '-dash',
  '_underscore',
  '.dotfile',
  '#hash',
  'ﬁle',
  'file',
  'ＡＢＣ',
  'ABC'
]

function makeWorktree(index: number, displayName: string | null): Worktree {
  // Trailing separators and Windows separators exercise `basename()`'s
  // normalisation on the rows whose displayName is blank.
  const suffixes = ['', '/', '//', '\\']
  return {
    id: `w${index}`,
    repoId: index % 2 === 0 ? 'repo1' : 'repo2',
    path: `/tmp/${TRICKY_LABELS[index % TRICKY_LABELS.length] ?? 'unnamed'}-${index}${suffixes[index % suffixes.length]}`,
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: false,
    // Cast: persisted/remote rows can arrive with a null displayName, which is
    // exactly the fallback path `getWorktreeSortLabel` guards.
    displayName: displayName as string,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    // Heavy tie density so the label tiebreaker actually decides the order.
    sortOrder: index % 3,
    manualOrder: index % 3,
    lastActivityAt: 1_700_000_000_000 - (index % 3)
  }
}

const corpus: Worktree[] = TRICKY_LABELS.flatMap((label, index) => [
  makeWorktree(index * 2, label),
  // Second row per label with a blank displayName, so `basename(path)` decides.
  makeWorktree(index * 2 + 1, index % 2 === 0 ? '' : null)
])

const repoMap = new Map<string, Repo>([
  [
    'repo1',
    { id: 'repo1', path: '/repo1', displayName: 'Ångström', badgeColor: '#000', addedAt: 0 }
  ],
  [
    'repo2',
    { id: 'repo2', path: '/repo2', displayName: 'angstrom', badgeColor: '#111', addedAt: 0 }
  ]
])

const SORT_MODES: readonly SortBy[] = ['name', 'smart', 'recent', 'repo', 'manual']
const NOW = 1_700_000_000_000

describe('worktree sort label ordering', () => {
  it('matches the pre-precompute comparator on every pair', () => {
    const labels = buildWorktreeSortLabels(corpus)
    for (const a of corpus) {
      for (const b of corpus) {
        expect(Math.sign(compareWorktreeSortLabel(a, b, labels))).toBe(
          Math.sign(legacyCompareWorktreeSortLabel(a, b))
        )
      }
    }
  })

  it('produces byte-for-byte identical sort output in every mode', () => {
    for (const sortBy of SORT_MODES) {
      const attention = new Map()
      const withLabels = [...corpus].sort(
        buildWorktreeComparator(sortBy, repoMap, NOW, attention, buildWorktreeSortLabels(corpus))
      )
      const withoutLabels = [...corpus].sort(
        buildWorktreeComparator(sortBy, repoMap, NOW, attention)
      )
      expect(withLabels.map((w) => w.id)).toEqual(withoutLabels.map((w) => w.id))
    }
  })

  it('falls back to deriving labels for rows missing from the precomputed map', () => {
    const [first, second] = corpus
    const partial = buildWorktreeSortLabels([first])
    expect(Math.sign(compareWorktreeSortLabel(first, second, partial))).toBe(
      Math.sign(legacyCompareWorktreeSortLabel(first, second))
    )
  })

  it('keys labels by row so a two-host id collision keeps each row its own label', () => {
    const local: Worktree = { ...makeWorktree(0, null), id: 'shared', path: '/tmp/aaa' }
    const remote: Worktree = { ...makeWorktree(1, null), id: 'shared', path: '/tmp/zzz' }
    const labels = buildWorktreeSortLabels([local, remote])

    expect(labels.get(local)).toBe('aaa')
    expect(labels.get(remote)).toBe('zzz')
    expect(Math.sign(compareWorktreeSortLabel(local, remote, labels))).toBe(
      Math.sign(legacyCompareWorktreeSortLabel(local, remote))
    )
  })
})
