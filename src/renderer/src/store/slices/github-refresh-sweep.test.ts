import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestStore,
  makePRRefreshWorktree,
  resetRemoteRuntimeMocks,
  runtimeEnvironmentCall
} from './github-slice-test-harness'
import type { AppState } from '../types'

describe('createGitHubSlice.refreshAllGitHub', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('keeps runtime issue dispatch repo identity reads linear', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-linear-issue',
      ok: true,
      result: null,
      _meta: { runtimeId: 'remote-runtime' }
    })
    const store = createTestStore()
    const repoCount = 128
    let repoIdentityReads = 0
    const repos = Array.from({ length: repoCount }, (_, index) => {
      const repoId = `issue-repo-${index}`
      const repoPath = `/runtime/issues-${index}`
      const repo = {
        id: repoId,
        path: repoPath,
        name: repoId,
        kind: 'git' as const,
        executionHostId: 'runtime:env-1'
      }
      Object.defineProperty(repo, 'id', {
        configurable: true,
        enumerable: true,
        get: () => {
          repoIdentityReads += 1
          return repoId
        }
      })
      return Object.defineProperty(repo, 'path', {
        configurable: true,
        enumerable: true,
        get: () => {
          repoIdentityReads += 1
          return repoPath
        }
      })
    })
    const worktreesByRepo = Object.fromEntries(
      repos.map((repo, index) => [
        repo.id,
        [
          makePRRefreshWorktree({
            id: `issue-wt-${index}`,
            repoId: repo.id,
            path: `${repo.path}/worktrees/feature`,
            linkedIssue: index + 1
          })
        ]
      ])
    )
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as AppState['settings'],
      repos,
      groupBy: 'repo',
      worktreeCardProperties: ['issue'],
      worktreesByRepo
    } as unknown as Partial<AppState>)
    repoIdentityReads = 0

    store.getState().refreshAllGitHub()

    await vi.waitFor(() => expect(Object.keys(store.getState().issueCache)).toHaveLength(repoCount))
    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(repoCount)
    expect(repoIdentityReads).toBeLessThanOrEqual(repoCount * 15)
  })
})
