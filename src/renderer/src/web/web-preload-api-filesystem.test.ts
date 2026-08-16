import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  installApi,
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

describe('web file preload API', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it('rejects native save-dialog downloads in paired web clients', async () => {
    const { api } = await installApi('Linux')

    await expect(
      api.fs.downloadFile({ filePath: '/workspace/repo/file.txt', connectionId: 'ssh-1' })
    ).rejects.toThrow('Remote file download is unavailable in paired web clients.')
    await expect(
      api.fs.downloadFolder({ dirPath: '/workspace/repo/src', connectionId: 'ssh-1' })
    ).rejects.toThrow('Remote folder download is unavailable in paired web clients.')
  })

  it('rejects SSH clone requests in paired web clients', async () => {
    const { api } = await installApi('Linux')

    await expect(
      api.repos.cloneRemote({
        connectionId: 'ssh-1',
        url: 'https://github.com/stablyai/orca.git',
        destination: '/workspace'
      })
    ).rejects.toThrow('SSH clone is unavailable in paired web clients.')
  })

  it('returns false for runtime missing-path errors from fs.pathExists', async () => {
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
            ok: false,
            error: { code: 'ENOENT', message: 'ENOENT: no such file' },
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
      globals.window.api.fs.pathExists({ filePath: '/workspace/repo/untitled.md' })
    ).resolves.toBe(false)
    expect(runtimeCalls).toEqual([
      { method: 'repo.list', params: undefined },
      { method: 'worktree.detectedList', params: { repo: 'repo-1' } },
      { method: 'files.stat', params: { worktree: 'id:wt-1', relativePath: 'untitled.md' } }
    ])
  })
})
