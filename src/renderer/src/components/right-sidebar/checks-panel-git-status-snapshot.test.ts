import { describe, expect, it } from 'vitest'
import {
  buildChecksPanelGitStatusContextKey,
  readChecksPanelPublishActionGitStatus,
  readChecksPanelGitStatusSnapshot,
  shouldClearChecksPanelGitStatusSnapshot,
  shouldCoalesceChecksPanelGitStatusSnapshotRefresh,
  shouldCommitChecksPanelGitStatusSnapshot,
  shouldPollChecksPanelRuntimeSshStatus,
  type ChecksPanelGitStatusSnapshot
} from './checks-panel-git-status-snapshot'

const SNAPSHOT: ChecksPanelGitStatusSnapshot = {
  contextKey: 'runtime:env-1::repo::worktree::branch',
  hasUncommittedChanges: true,
  remoteStatus: {
    hasUpstream: false,
    ahead: 0,
    behind: 0
  }
}

describe('buildChecksPanelGitStatusContextKey', () => {
  it('changes when an explicit push target changes', () => {
    const base = {
      repoId: 'repo-1',
      worktreeId: 'worktree-1',
      worktreePath: 'repo-worktree',
      branch: 'feature/checks',
      runtimeEnvironmentId: 'runtime-1',
      repoConnectionId: 'ssh-1'
    }

    expect(
      buildChecksPanelGitStatusContextKey({
        ...base,
        pushTarget: { remoteName: 'origin', branchName: 'feature/checks' }
      })
    ).not.toBe(
      buildChecksPanelGitStatusContextKey({
        ...base,
        pushTarget: { remoteName: 'fork', branchName: 'feature/checks' }
      })
    )
  })

  it('changes when linked hosted review metadata changes', () => {
    const base = {
      repoId: 'repo-1',
      worktreeId: 'worktree-1',
      worktreePath: 'repo-worktree',
      branch: 'feature/checks',
      runtimeEnvironmentId: 'runtime-1',
      repoConnectionId: 'ssh-1',
      pushTarget: null
    }
    const unlinkedContext = buildChecksPanelGitStatusContextKey({
      ...base,
      linkedGitHubPR: null,
      linkedGitLabMR: null,
      linkedBitbucketPR: null,
      linkedAzureDevOpsPR: null,
      linkedGiteaPR: null
    })

    expect(
      buildChecksPanelGitStatusContextKey({
        ...base,
        linkedGitHubPR: 12,
        linkedGitLabMR: null,
        linkedBitbucketPR: null,
        linkedAzureDevOpsPR: null,
        linkedGiteaPR: null
      })
    ).not.toBe(unlinkedContext)
    expect(
      buildChecksPanelGitStatusContextKey({
        ...base,
        linkedGitHubPR: null,
        linkedGitLabMR: null,
        linkedBitbucketPR: 34,
        linkedAzureDevOpsPR: null,
        linkedGiteaPR: null
      })
    ).not.toBe(unlinkedContext)
    expect(
      buildChecksPanelGitStatusContextKey({
        ...base,
        linkedGitHubPR: null,
        linkedGitLabMR: null,
        linkedBitbucketPR: null,
        linkedAzureDevOpsPR: 56,
        linkedGiteaPR: null
      })
    ).not.toBe(unlinkedContext)
    expect(
      buildChecksPanelGitStatusContextKey({
        ...base,
        linkedGitHubPR: null,
        linkedGitLabMR: null,
        linkedBitbucketPR: null,
        linkedAzureDevOpsPR: null,
        linkedGiteaPR: 78
      })
    ).not.toBe(unlinkedContext)
  })
})

describe('readChecksPanelGitStatusSnapshot', () => {
  it('returns status inputs for the matching panel context', () => {
    expect(readChecksPanelGitStatusSnapshot(SNAPSHOT, SNAPSHOT.contextKey)).toEqual({
      hasUncommittedChanges: true,
      remoteStatus: {
        hasUpstream: false,
        ahead: 0,
        behind: 0
      }
    })
  })

  it('withholds worktree-keyed status after a runtime or SSH context change', () => {
    expect(
      readChecksPanelGitStatusSnapshot(SNAPSHOT, 'runtime:env-2::repo::worktree::branch')
    ).toEqual({
      hasUncommittedChanges: undefined,
      remoteStatus: undefined
    })
  })
})

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

  it('falls back to active worktree status when the panel snapshot is unavailable', () => {
    expect(
      readChecksPanelPublishActionGitStatus({
        snapshot: null,
        contextKey: SNAPSHOT.contextKey,
        fallbackEntries: [],
        fallbackRemoteStatus: {
          hasUpstream: false,
          ahead: 0,
          behind: 0
        }
      })
    ).toEqual({
      hasUncommittedChanges: false,
      remoteStatus: {
        hasUpstream: false,
        ahead: 0,
        behind: 0
      }
    })
  })

  it('does not synthesize publish inputs without fallback upstream status', () => {
    expect(
      readChecksPanelPublishActionGitStatus({
        snapshot: null,
        contextKey: SNAPSHOT.contextKey,
        fallbackEntries: [],
        fallbackRemoteStatus: undefined
      })
    ).toEqual({
      hasUncommittedChanges: undefined,
      remoteStatus: undefined
    })
  })
})

describe('shouldCommitChecksPanelGitStatusSnapshot', () => {
  it('suppresses stale status refresh completions from an older execution boundary', () => {
    expect(
      shouldCommitChecksPanelGitStatusSnapshot(
        'runtime:env-2::repo::worktree::branch',
        'runtime:env-1::repo::worktree::branch'
      )
    ).toBe(false)
  })
})

describe('shouldCoalesceChecksPanelGitStatusSnapshotRefresh', () => {
  it('coalesces only requests for the same panel context', () => {
    expect(
      shouldCoalesceChecksPanelGitStatusSnapshotRefresh(
        'runtime:env-1::repo::worktree::branch',
        'runtime:env-1::repo::worktree::branch'
      )
    ).toBe(true)
    expect(
      shouldCoalesceChecksPanelGitStatusSnapshotRefresh(
        'runtime:env-1::repo::worktree::branch',
        'runtime:env-2::repo::worktree::branch'
      )
    ).toBe(false)
  })
})

describe('shouldClearChecksPanelGitStatusSnapshot', () => {
  it('keeps the current snapshot while a same-context refresh is in flight', () => {
    expect(shouldClearChecksPanelGitStatusSnapshot(SNAPSHOT, SNAPSHOT.contextKey)).toBe(false)
  })

  it('clears snapshots from another execution boundary', () => {
    expect(
      shouldClearChecksPanelGitStatusSnapshot(SNAPSHOT, 'runtime:env-2::repo::worktree::branch')
    ).toBe(true)
  })
})

describe('shouldPollChecksPanelRuntimeSshStatus', () => {
  it('polls while a runtime environment is driving an SSH-backed repo', () => {
    expect(
      shouldPollChecksPanelRuntimeSshStatus({
        isPanelVisible: true,
        runtimeEnvironmentId: 'runtime-1',
        repoConnectionId: 'ssh-1'
      })
    ).toBe(true)
  })

  it('does not poll when the Checks panel is hidden or execution is not runtime-routed SSH', () => {
    expect(
      shouldPollChecksPanelRuntimeSshStatus({
        isPanelVisible: false,
        runtimeEnvironmentId: 'runtime-1',
        repoConnectionId: 'ssh-1'
      })
    ).toBe(false)
    expect(
      shouldPollChecksPanelRuntimeSshStatus({
        isPanelVisible: true,
        runtimeEnvironmentId: null,
        repoConnectionId: 'ssh-1'
      })
    ).toBe(false)
    expect(
      shouldPollChecksPanelRuntimeSshStatus({
        isPanelVisible: true,
        runtimeEnvironmentId: 'runtime-1',
        repoConnectionId: null
      })
    ).toBe(false)
  })
})
