import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearGitStatusRefreshOrderingForTests,
  refreshGitStatusForWorktree,
  refreshGitStatusForWorktreeStrict,
  type GitStatusRefreshDeps
} from './git-status-refresh'
import { useAppStore } from '../../store'
import type { Repo } from '../../../../shared/repo-types'
import type { GitStatusResult } from '../../../../shared/git-status-types'

const REPO_ID = 'repo-1'
const WORKTREE_ID = `${REPO_ID}::/repo`

function makeDeps(): GitStatusRefreshDeps {
  return {
    setGitStatus: vi.fn(),
    updateWorktreeGitIdentity: vi.fn(),
    setUpstreamStatus: vi.fn(),
    fetchUpstreamStatus: vi.fn().mockResolvedValue(null)
  }
}

function stubGitStatus(): ReturnType<typeof vi.fn> {
  const status: GitStatusResult = {
    entries: [],
    conflictOperation: 'unknown',
    upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 }
  }
  const gitStatus = vi.fn().mockResolvedValue(status)
  vi.stubGlobal('window', {
    api: {
      git: {
        status: gitStatus,
        cancelStatus: vi.fn().mockResolvedValue(undefined),
        upstreamStatus: vi.fn().mockResolvedValue({ hasUpstream: false, ahead: 0, behind: 0 })
      }
    }
  })
  return gitStatus
}

function seedRepo(showSubmoduleChanges: boolean): void {
  const repo = {
    id: REPO_ID,
    path: '/repo',
    displayName: 'repo',
    badgeColor: '#000000',
    addedAt: 1,
    kind: 'git',
    connectionId: 'ssh-1',
    ...(showSubmoduleChanges ? { showSubmoduleChanges: true } : {})
  } as Repo
  useAppStore.setState({ repos: [repo] })
}

describe('submodule opt-in on git status refreshes', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    clearGitStatusRefreshOrderingForTests()
    useAppStore.setState({ repos: [] })
  })

  it('carries the repo opt-in to an SSH-hosted worktree, which the host handler cannot resolve', async () => {
    const gitStatus = stubGitStatus()
    seedRepo(true)

    await refreshGitStatusForWorktree({
      worktreeId: WORKTREE_ID,
      worktreePath: '/repo',
      connectionId: 'ssh-1',
      deps: makeDeps()
    })

    expect(gitStatus).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'ssh-1', showSubmoduleChanges: true })
    )
  })

  it('carries it on a strict refresh too', async () => {
    const gitStatus = stubGitStatus()
    seedRepo(true)

    await refreshGitStatusForWorktreeStrict({
      worktreeId: WORKTREE_ID,
      worktreePath: '/repo',
      connectionId: 'ssh-1',
      deps: makeDeps()
    })

    expect(gitStatus).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'ssh-1', showSubmoduleChanges: true })
    )
  })

  it('omits it when the repo never opted in', async () => {
    const gitStatus = stubGitStatus()
    seedRepo(false)

    await refreshGitStatusForWorktree({
      worktreeId: WORKTREE_ID,
      worktreePath: '/repo',
      connectionId: 'ssh-1',
      deps: makeDeps()
    })

    expect(gitStatus).toHaveBeenCalledWith(
      expect.not.objectContaining({ showSubmoduleChanges: true })
    )
  })
})
