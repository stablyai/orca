import { describe, expect, it } from 'vitest'
import { dedupeRemoteTrackingRefs } from './git-history-ref-display'
import type { GitHistoryItemRef } from './git-history-types'

function localBranch(name: string): GitHistoryItemRef {
  return { id: `refs/heads/${name}`, name, category: 'branches' }
}

function remoteBranch(name: string): GitHistoryItemRef {
  return { id: `refs/remotes/${name}`, name, category: 'remote branches' }
}

describe('dedupeRemoteTrackingRefs', () => {
  it('drops a remote-tracking ref when the matching local branch is present', () => {
    const refs = [localBranch('feature'), remoteBranch('origin/feature')]
    expect(dedupeRemoteTrackingRefs(refs)).toEqual([localBranch('feature')])
  })

  it('keeps slash-containing remote refs because the remote name is ambiguous', () => {
    const refs = [localBranch('bar/main'), remoteBranch('foo/bar/main')]
    expect(dedupeRemoteTrackingRefs(refs)).toEqual(refs)
  })

  it('keeps a remote-tracking ref with no matching local branch', () => {
    const refs = [localBranch('main'), remoteBranch('origin/release')]
    expect(dedupeRemoteTrackingRefs(refs)).toEqual(refs)
  })

  it('keeps matching remote refs when multiple remotes point to the same branch name', () => {
    const refs = [localBranch('main'), remoteBranch('origin/main'), remoteBranch('upstream/main')]
    expect(dedupeRemoteTrackingRefs(refs)).toEqual(refs)
  })

  it('keeps a matching remote ref when the caller marks it as preserved context', () => {
    const refs = [localBranch('main'), remoteBranch('origin/main')]
    expect(
      dedupeRemoteTrackingRefs(refs, { preserveRefIds: ['refs/remotes/origin/main'] })
    ).toEqual(refs)
  })

  it('keeps tags and non-remote refs untouched', () => {
    const refs: GitHistoryItemRef[] = [
      localBranch('main'),
      { id: 'refs/tags/v1', name: 'v1', category: 'tags' }
    ]
    expect(dedupeRemoteTrackingRefs(refs)).toEqual(refs)
  })

  it('returns all refs when there are no local branches', () => {
    const refs = [remoteBranch('origin/main')]
    expect(dedupeRemoteTrackingRefs(refs)).toEqual(refs)
  })
})
