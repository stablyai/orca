import { describe, expect, it } from 'vitest'
import type { GitUpstreamStatus } from '../../../../shared/git/status/git-status-types'
import {
  getWorkspaceSyncOffer,
  planWorkspaceOnHost,
  resolveHostRemoteBranch
} from './open-on-host-branch-plan'

const up = (o: Partial<GitUpstreamStatus>): GitUpstreamStatus => ({
  hasUpstream: true,
  upstreamName: 'origin/feature/x',
  ahead: 0,
  behind: 0,
  ...o
})

describe('getWorkspaceSyncOffer', () => {
  it('offers publish for a branch with no upstream', () =>
    expect(
      getWorkspaceSyncOffer(up({ hasUpstream: false, upstreamName: undefined }), 'feature/x')
    ).toBe('publish'))
  it('offers push when ahead', () =>
    expect(getWorkspaceSyncOffer(up({ ahead: 2 }), 'feature/x')).toBe('push'))
  it('offers publish for an older workspace whose branch tracks origin/main', () =>
    expect(getWorkspaceSyncOffer(up({ upstreamName: 'origin/main' }), 'feature-x')).toBe('publish'))
})

describe('planWorkspaceOnHost', () => {
  it('blocks a detached HEAD', () =>
    expect(planWorkspaceOnHost({ branch: '', upstream: up({}), syncFirst: true })).toEqual({
      kind: 'blocked',
      reason: 'detached'
    }))
  it('blocks an unpublished branch when publish is declined', () =>
    expect(
      planWorkspaceOnHost({
        branch: 'feature/x',
        upstream: up({ hasUpstream: false }),
        syncFirst: false
      })
    ).toEqual({ kind: 'blocked', reason: 'unpublished' }))
  it('opens at the remote tip and counts local commits when push is declined', () =>
    expect(
      planWorkspaceOnHost({ branch: 'feature/x', upstream: up({ ahead: 3 }), syncFirst: false })
    ).toEqual({ kind: 'ready', sync: 'none', localOnlyCommits: 3, expectSameHead: false }))
  it('pushes first when accepted', () =>
    expect(
      planWorkspaceOnHost({ branch: 'feature/x', upstream: up({ ahead: 3 }), syncFirst: true })
    ).toEqual({ kind: 'ready', sync: 'push', localOnlyCommits: 0, expectSameHead: true }))
})

describe('resolveHostRemoteBranch', () => {
  it('keeps slashes in the branch and uses the fork push target remote', () => {
    expect(resolveHostRemoteBranch(up({}), 'feature/x')).toEqual({
      remoteName: 'origin',
      branchName: 'feature/x'
    })
    expect(
      resolveHostRemoteBranch(up({ upstreamName: 'fork/feature/x' }), 'feature/x', {
        remoteName: 'fork',
        branchName: 'feature/x'
      })
    ).toEqual({ remoteName: 'fork', branchName: 'feature/x' })
  })
  it('never opens origin/main for a branch that only tracks it', () =>
    expect(resolveHostRemoteBranch(up({ upstreamName: 'origin/main' }), 'feature-x')).toBeNull())
})
