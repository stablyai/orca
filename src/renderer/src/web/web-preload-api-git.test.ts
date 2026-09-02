import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  TEST_COMMIT_OID,
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

describe('web git preload API', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it('routes remote commit URL requests through the runtime git API', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    const worktree = {
      id: 'wt-1',
      repoId: 'repo-1',
      path: '/workspace/repo',
      head: 'abc123',
      branch: 'refs/heads/main',
      isBare: false,
      isMainWorktree: true,
      displayName: 'repo',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      linkedGitLabMR: null,
      linkedGitLabIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      workspaceStatus: 'todo'
    }
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          if (method === 'repo.list') {
            return Promise.resolve({
              id: `call-${runtimeCalls.length}`,
              ok: true,
              result: { repos: [{ id: 'repo-1' }] },
              _meta: { runtimeId: 'runtime-1' }
            })
          }
          if (method === 'worktree.detectedList') {
            return Promise.resolve({
              id: `call-${runtimeCalls.length}`,
              ok: true,
              result: { repoId: 'repo-1', authoritative: true, worktrees: [worktree] },
              _meta: { runtimeId: 'runtime-1' }
            })
          }
          if (method === 'git.remoteCommitUrl') {
            return Promise.resolve({
              id: `call-${runtimeCalls.length}`,
              ok: true,
              result: `https://git.example.com/project/commit/${TEST_COMMIT_OID}`,
              _meta: { runtimeId: 'runtime-1' }
            })
          }
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: false,
            error: { code: 'unexpected_method', message: `Unexpected method: ${method}` },
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await expect(
      globals.window.api.git.remoteCommitUrl({
        worktreePath: '/workspace/repo',
        sha: TEST_COMMIT_OID
      })
    ).resolves.toBe(`https://git.example.com/project/commit/${TEST_COMMIT_OID}`)
    expect(runtimeCalls).toEqual([
      { method: 'repo.list', params: undefined },
      { method: 'worktree.detectedList', params: { repo: 'repo-1' } },
      { method: 'git.remoteCommitUrl', params: { worktree: 'id:wt-1', sha: TEST_COMMIT_OID } }
    ])
  })

  it('sends the branch line total merge base only when the chip asked for one', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    const worktree = {
      id: 'wt-1',
      repoId: 'repo-1',
      path: '/workspace/repo',
      head: 'abc123',
      branch: 'refs/heads/main',
      isBare: false,
      isMainWorktree: true,
      displayName: 'repo',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      linkedGitLabMR: null,
      linkedGitLabIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      workspaceStatus: 'todo'
    }
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          if (method === 'repo.list') {
            return Promise.resolve({
              id: `call-${runtimeCalls.length}`,
              ok: true,
              result: { repos: [{ id: 'repo-1' }] },
              _meta: { runtimeId: 'runtime-1' }
            })
          }
          if (method === 'worktree.detectedList') {
            return Promise.resolve({
              id: `call-${runtimeCalls.length}`,
              ok: true,
              result: { repoId: 'repo-1', authoritative: true, worktrees: [worktree] },
              _meta: { runtimeId: 'runtime-1' }
            })
          }
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: true,
            result: { entries: [], conflictOperation: 'unknown' },
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await globals.window.api.git.status({
      worktreePath: '/workspace/repo',
      branchLineTotalMergeBase: TEST_COMMIT_OID
    })
    await globals.window.api.git.status({ worktreePath: '/workspace/repo' })
    await globals.window.api.git.status({
      worktreePath: '/workspace/repo',
      includeLineStats: false
    })
    await globals.window.api.git.branchCompare({
      worktreePath: '/workspace/repo',
      baseRef: 'origin/main',
      admissionTier: 'background'
    })

    const statusCalls = runtimeCalls.filter((call) => call.method === 'git.status')
    // Why: strict — `toEqual` would pass on a forwarded `branchLineTotalMergeBase: undefined`,
    // which is exactly what the conditional spread must avoid sending.
    expect(statusCalls).toStrictEqual([
      {
        method: 'git.status',
        params: {
          worktree: 'id:wt-1',
          includeIgnored: undefined,
          includeLineStats: undefined,
          bypassEffectiveUpstreamNegativeCache: undefined,
          reuseLineStats: undefined,
          branchLineTotalMergeBase: TEST_COMMIT_OID
        }
      },
      {
        method: 'git.status',
        params: {
          worktree: 'id:wt-1',
          includeIgnored: undefined,
          includeLineStats: undefined,
          bypassEffectiveUpstreamNegativeCache: undefined,
          reuseLineStats: undefined
        }
      },
      {
        method: 'git.status',
        params: {
          worktree: 'id:wt-1',
          includeIgnored: undefined,
          includeLineStats: false,
          bypassEffectiveUpstreamNegativeCache: undefined,
          reuseLineStats: undefined
        }
      }
    ])
    expect(runtimeCalls.find((call) => call.method === 'git.branchCompare')).toStrictEqual({
      method: 'git.branchCompare',
      params: {
        worktree: 'id:wt-1',
        baseRef: 'origin/main',
        admissionTier: 'background'
      }
    })
  })
})
