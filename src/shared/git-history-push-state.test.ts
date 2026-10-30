import { describe, expect, it } from 'vitest'
import type { GitHistoryItem } from './git-history-types'
import { resolveGitHistoryUnpushedIds } from './git-history-push-state'

function item(id: string, parentIds: string[]): GitHistoryItem {
  return { id, parentIds, subject: id, message: id }
}

const current = { id: 'refs/heads/feature', name: 'feature', revision: 'c3' }
const remote = { id: 'refs/remotes/origin/feature', name: 'origin/feature' }

describe('resolveGitHistoryUnpushedIds', () => {
  it('marks nothing when the branch matches its upstream', () => {
    const items = [item('c3', ['c2']), item('c2', [])]
    expect(
      resolveGitHistoryUnpushedIds({
        items,
        currentRef: current,
        remoteRef: { ...remote, revision: 'c3' }
      })
    ).toEqual(new Set())
  })

  it('marks every commit on a branch with no upstream at all', () => {
    const items = [item('c3', ['c2']), item('c2', [])]
    expect(
      resolveGitHistoryUnpushedIds({ items, currentRef: current }, { hasUpstream: false, ahead: 0 })
    ).toEqual(new Set(['c3', 'c2']))
  })

  it('trusts status for a branch pushed without -u, which history sees as untracked', () => {
    const items = [item('c3', ['c2']), item('c2', [])]
    expect(
      resolveGitHistoryUnpushedIds({ items, currentRef: current }, { hasUpstream: true, ahead: 0 })
    ).toEqual(new Set())
    expect(
      resolveGitHistoryUnpushedIds({ items, currentRef: current }, { hasUpstream: true, ahead: 1 })
    ).toBeNull()
  })

  it('keeps a merged-in side commit unpushed when only the merge base is on the upstream', () => {
    // c3 merges side s1 into c2; the upstream stops at c1.
    const items = [
      item('c3', ['c2', 's1']),
      item('s1', ['c1']),
      item('c2', ['c1']),
      item('c1', ['c0']),
      item('c0', [])
    ]
    expect(
      resolveGitHistoryUnpushedIds({
        items,
        currentRef: current,
        remoteRef: { ...remote, revision: 'c1' },
        mergeBase: 'c1'
      })
    ).toEqual(new Set(['c3', 's1', 'c2']))
  })

  it('claims nothing on a detached HEAD, which has no branch to push', () => {
    const items = [item('c3', ['c2']), item('c2', [])]
    expect(
      resolveGitHistoryUnpushedIds({
        items,
        currentRef: { id: 'c3', name: 'c3', revision: 'c3', category: 'commits' }
      })
    ).toBeNull()
  })
})
