import { describe, expect, it } from 'vitest'
import {
  readChecksPanelPublishActionGitStatus,
  readChecksPanelRefreshGitIdentitySnapshot,
  type ChecksPanelGitStatusSnapshot
} from './checks-panel-git-status-snapshot'

const SNAPSHOT: ChecksPanelGitStatusSnapshot = {
  contextKey: 'runtime:env-1::repo::worktree::branch',
  hasUncommittedChanges: true,
  remoteStatus: {
    hasUpstream: false,
    ahead: 0,
    behind: 0
  },
  gitIdentity: {
    head: 'abc123',
    branch: 'refs/heads/feature/checks'
  }
}

describe('readChecksPanelPublishActionGitStatus', () => {
  it('uses the matching panel snapshot before worktree-keyed fallback status', () => {
    expect(
      readChecksPanelPublishActionGitStatus({
        snapshot: SNAPSHOT,
        contextKey: SNAPSHOT.contextKey,
        fallbackEntries: [],
        fallbackRemoteStatus: {
          hasUpstream: true,
          ahead: 0,
          behind: 0
        }
      })
    ).toEqual({
      hasUncommittedChanges: true,
      remoteStatus: {
        hasUpstream: false,
        ahead: 0,
        behind: 0
      }
    })
  })
})

describe('readChecksPanelRefreshGitIdentitySnapshot', () => {
  it('treats refs/heads display differences as the same branch identity', () => {
    expect(
      readChecksPanelRefreshGitIdentitySnapshot({
        snapshot: SNAPSHOT,
        contextKey: SNAPSHOT.contextKey,
        currentBranch: 'feature/checks'
      })
    ).toEqual({ kind: 'same' })
  })
})
