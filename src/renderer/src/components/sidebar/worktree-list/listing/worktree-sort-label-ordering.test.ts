import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  buildWorktreeSortLabels,
  compareWorktreeSortLabel
} from '../../../../../../shared/sidebar-list/sorting/smart-sort'

/** The comparator with labels derived per comparison instead of precomputed. */

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
  // Blank names must normalize trailing and Windows path separators consistently.
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

describe('worktree sort label ordering', () => {
  it('breaks an equal-label tie by host-qualified id, independent of input order', () => {
    const local: Worktree = { ...makeWorktree(0, 'same'), id: 'shared', hostId: 'local' }
    const remote: Worktree = { ...makeWorktree(1, 'same'), id: 'shared', hostId: 'ssh:box' }
    const labels = buildWorktreeSortLabels([local, remote])
    const compare = (a: Worktree, b: Worktree): number => compareWorktreeSortLabel(a, b, labels)
    expect([remote, local].sort(compare)).toEqual([local, remote])
    expect([local, remote].sort(compare)).toEqual([local, remote])
  })
})
