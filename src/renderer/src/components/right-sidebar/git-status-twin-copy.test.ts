// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { GitStatusResult } from '../../../../shared/git-status-types'
import { useAppStore } from '@/store'
import { resolveWorktreeGitCopyNow, worktreeCopyPushTarget } from '@/lib/worktree-git-copy'
import { refreshGitStatusForWorktree } from './git-status-refresh'

// #32918: the same project at the same path on this machine and on an SSH host.
const id = 'repo1::/srv/ai-tools'
const initialAppState = useAppStore.getInitialState()

function repo(overrides: Partial<Repo>): Repo {
  return {
    id: 'repo1',
    path: '/srv/ai-tools',
    displayName: 'ai-tools',
    badgeColor: '#000',
    addedAt: 0,
    kind: 'git',
    ...overrides
  }
}

function copy(overrides: Partial<Worktree>): Worktree {
  return {
    id,
    repoId: 'repo1',
    path: '/srv/ai-tools',
    head: 'aaa',
    branch: 'refs/heads/master',
    isBare: false,
    isMainWorktree: true,
    displayName: 'master',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

const status = vi.fn<(args: { connectionId?: string }) => Promise<GitStatusResult>>()

beforeEach(() => {
  status.mockResolvedValue({
    entries: [],
    head: 'bbb2',
    branch: 'refs/heads/feature',
    upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 },
    conflictOperation: 'unknown'
  })
  vi.stubGlobal('window', { ...window, api: { git: { status } } })
  useAppStore.setState({
    repos: [repo({ connectionId: null }), repo({ connectionId: 'box-b' })],
    worktreesByRepo: {
      repo1: [
        copy({ hostId: 'local' }),
        copy({
          hostId: 'ssh:box-b',
          head: 'bbb',
          branch: 'refs/heads/feature',
          displayName: 'feature'
        })
      ]
    },
    activeWorktreeId: id,
    activeWorkspaceExecutionHostId: 'ssh:box-b'
  })
})

afterEach(() => {
  useAppStore.setState(initialAppState, true)
  vi.unstubAllGlobals()
})

describe('git status poll for a same-path twin', () => {
  it('refuses an unselected twin instead of guessing a copy', () => {
    useAppStore.setState({ activeWorktreeId: null, activeWorkspaceExecutionHostId: null })

    expect(resolveWorktreeGitCopyNow(id)).toBeNull()
  })

  it("asks the selected SSH copy's host and patches only that copy", async () => {
    const target = resolveWorktreeGitCopyNow(id)
    expect(target).toMatchObject({ hostId: 'ssh:box-b', connectionId: 'box-b' })
    if (!target) {
      return
    }
    const state = useAppStore.getState()

    await refreshGitStatusForWorktree({
      target: target.transport,
      ownerHostId: target.hostId,
      worktreeId: id,
      worktreePath: '/srv/ai-tools',
      connectionId: target.connectionId,
      deps: {
        setGitStatus: state.setGitStatus,
        updateWorktreeGitIdentity: state.updateWorktreeGitIdentity,
        setUpstreamStatus: state.setUpstreamStatus,
        fetchUpstreamStatus: async () => null
      }
    })

    expect(status).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'box-b' }))
    const [local, remote] = useAppStore.getState().worktreesByRepo.repo1
    expect(local).toMatchObject({ head: 'aaa', branch: 'refs/heads/master' })
    expect(remote).toMatchObject({ head: 'bbb2', branch: 'refs/heads/feature' })
  })
})

describe('push target for a same-path twin', () => {
  it("names the pinned SSH copy's remote and branch, not the local copy's", () => {
    const [local, remote] = useAppStore.getState().worktreesByRepo.repo1
    useAppStore.setState({
      worktreesByRepo: {
        repo1: [
          { ...local, pushTarget: { remoteName: 'origin', branchName: 'local-review' } },
          { ...remote, pushTarget: { remoteName: 'fork', branchName: 'remote-review' } }
        ]
      }
    })

    expect(worktreeCopyPushTarget(useAppStore.getState(), id, 'ssh:box-b')).toEqual({
      remoteName: 'fork',
      branchName: 'remote-review'
    })
    // An unplaced host must not fall back to either twin, nor to a lone copy stamped elsewhere.
    expect(worktreeCopyPushTarget(useAppStore.getState(), id, 'ssh:other')).toBeUndefined()
    useAppStore.setState({
      worktreesByRepo: { repo1: [useAppStore.getState().worktreesByRepo.repo1[0]] }
    })
    expect(worktreeCopyPushTarget(useAppStore.getState(), id, 'ssh:box-b')).toBeUndefined()
  })
})
