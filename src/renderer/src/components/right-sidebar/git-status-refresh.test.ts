import { beforeEach, describe, expect, it, vi } from 'vitest'
import { refreshGitStatusForWorktree, type GitStatusRefreshDeps } from './git-status-refresh'
import type { GitStatusResult } from '../../../../shared/types'

function makeDeps(): GitStatusRefreshDeps {
  return {
    setGitStatus: vi.fn(),
    updateWorktreeGitIdentity: vi.fn(),
    setUpstreamStatus: vi.fn(),
    fetchUpstreamStatus: vi.fn().mockResolvedValue(undefined)
  }
}

describe('refreshGitStatusForWorktree', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('stores status, branch identity, and upstream data from git status', async () => {
    const status: GitStatusResult = {
      entries: [{ path: 'src/index.ts', status: 'modified', area: 'unstaged' }],
      conflictOperation: 'unknown',
      head: 'abc123',
      branch: 'refs/heads/feature',
      upstreamStatus: {
        hasUpstream: true,
        upstreamName: 'origin/feature',
        ahead: 2,
        behind: 1
      }
    }
    const gitStatus = vi.fn().mockResolvedValue(status)
    vi.stubGlobal('window', { api: { git: { status: gitStatus } } })
    const deps = makeDeps()

    await refreshGitStatusForWorktree({
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      connectionId: 'ssh-1',
      deps
    })

    expect(gitStatus).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: 'ssh-1',
      includeIgnored: true
    })
    expect(deps.setGitStatus).toHaveBeenCalledWith('wt-1', status)
    expect(deps.updateWorktreeGitIdentity).toHaveBeenCalledWith('wt-1', {
      head: 'abc123',
      branch: 'refs/heads/feature'
    })
    expect(deps.setUpstreamStatus).toHaveBeenCalledWith('wt-1', status.upstreamStatus)
    expect(deps.fetchUpstreamStatus).not.toHaveBeenCalled()
  })

  it('falls back to explicit upstream refresh for legacy status payloads', async () => {
    const status: GitStatusResult = {
      entries: [],
      conflictOperation: 'unknown',
      head: 'def456',
      branch: 'refs/heads/main'
    }
    const gitStatus = vi.fn().mockResolvedValue(status)
    vi.stubGlobal('window', { api: { git: { status: gitStatus } } })
    const deps = makeDeps()

    await refreshGitStatusForWorktree({
      worktreeId: 'wt-2',
      worktreePath: '/repo',
      connectionId: 'ssh-2',
      deps
    })

    expect(deps.setGitStatus).toHaveBeenCalledWith('wt-2', status)
    expect(deps.updateWorktreeGitIdentity).toHaveBeenCalledWith('wt-2', {
      head: 'def456',
      branch: 'refs/heads/main'
    })
    expect(deps.setUpstreamStatus).not.toHaveBeenCalled()
    expect(deps.fetchUpstreamStatus).toHaveBeenCalledWith('wt-2', '/repo', 'ssh-2')
  })

  it('omits ignored-file status when the setting is disabled', async () => {
    const status: GitStatusResult = {
      entries: [],
      conflictOperation: 'unknown'
    }
    const gitStatus = vi.fn().mockResolvedValue(status)
    vi.stubGlobal('window', { api: { git: { status: gitStatus } } })
    const deps = makeDeps()

    await refreshGitStatusForWorktree({
      settings: { activeRuntimeEnvironmentId: null, showGitIgnoredFiles: false },
      worktreeId: 'wt-3',
      worktreePath: '/repo',
      deps
    })

    expect(gitStatus).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined
    })
    expect(deps.setGitStatus).toHaveBeenCalledWith('wt-3', status)
  })
})
