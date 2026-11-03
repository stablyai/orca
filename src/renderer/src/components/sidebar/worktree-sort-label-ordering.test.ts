import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  buildWorktreeSortLabels,
  compareWorktreeSortLabel,
  getWorktreeSortLabel
} from '../../../../shared/sidebar-list/smart-sort'
import { compareCodePoints, compareSidebarText } from '../../../../shared/sidebar-list/text-order'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'

/** The comparator with labels derived per comparison instead of precomputed. */
function legacyCompareWorktreeSortLabel(a: Worktree, b: Worktree): number {
  return (
    compareSidebarText(getWorktreeSortLabel(a), getWorktreeSortLabel(b)) ||
    compareCodePoints(getWorktreeHostIdentity(a), getWorktreeHostIdentity(b))
  )
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

  it('breaks an equal-label tie by host-qualified id, independent of input order', () => {
    const local: Worktree = { ...makeWorktree(0, 'same'), id: 'shared', hostId: 'local' }
    const remote: Worktree = { ...makeWorktree(1, 'same'), id: 'shared', hostId: 'ssh:box' }
    const labels = buildWorktreeSortLabels([local, remote])
    const compare = (a: Worktree, b: Worktree): number => compareWorktreeSortLabel(a, b, labels)
    expect([remote, local].sort(compare)).toEqual([local, remote])
    expect([local, remote].sort(compare)).toEqual([local, remote])
  })
})
