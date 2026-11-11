import { describe, expect, it, vi } from 'vitest'
import { searchRuntimeFilePaths } from './runtime-file-search-client'
import {
  runtimeEnvironmentCall,
  runtimeEnvironmentSubscribe,
  installRuntimeFileClientEnvironment
} from '../runtime-file-client-test-harness'

installRuntimeFileClientEnvironment()

describe('runtime file client', () => {
  it('cancels a legacy paired inventory scan when its only search is superseded', async () => {
    const controller = new AbortController()
    const unsubscribeSearch = vi.fn()
    const unsubscribeList = vi.fn()
    runtimeEnvironmentSubscribe.mockImplementation((request, callbacks) => {
      if (request.method === 'files.searchPaths') {
        callbacks.onResponse({
          id: 'rpc-legacy-search',
          ok: true,
          result: {
            worktree: 'wt-1',
            rootPath: '/remote/repo',
            files: [],
            totalCount: 0,
            truncated: false
          },
          _meta: { runtimeId: 'legacy-runtime' }
        })
        return Promise.resolve({ unsubscribe: unsubscribeSearch })
      }
      expect(request.method).toBe('files.list')
      return Promise.resolve({ unsubscribe: unsubscribeList })
    })

    const pending = searchRuntimeFilePaths(
      {
        target: { kind: 'environment' as const, environmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/remote/repo'
      },
      {
        query: 'target',
        limit: 32,
        excludePaths: ['/remote/repo/nested'],
        signal: controller.signal
      }
    )
    await vi.waitFor(() => expect(runtimeEnvironmentSubscribe).toHaveBeenCalledTimes(2))

    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })

    const retryController = new AbortController()
    const retry = searchRuntimeFilePaths(
      {
        target: { kind: 'environment' as const, environmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/remote/repo'
      },
      {
        query: 'target',
        limit: 32,
        excludePaths: ['/remote/repo/nested'],
        signal: retryController.signal
      }
    )
    await vi.waitFor(() => expect(runtimeEnvironmentSubscribe).toHaveBeenCalledTimes(4))
    retryController.abort()
    await expect(retry).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('does not reuse a legacy inventory after a folder workspace root changes', async () => {
    runtimeEnvironmentCall.mockImplementation(({ method, params }) => {
      if (method === 'files.searchPaths') {
        return Promise.resolve({
          id: 'rpc-search-legacy',
          ok: false,
          error: { code: 'method_not_found', message: 'Unknown method: files.searchPaths' },
          _meta: { runtimeId: 'legacy-runtime' }
        })
      }
      const rootPath =
        runtimeEnvironmentCall.mock.calls.filter(([request]) => request.method === 'files.list')
          .length === 1
          ? '/old/root'
          : '/new/root'
      return Promise.resolve({
        id: `rpc-list-${rootPath}`,
        ok: true,
        result: {
          worktree: String((params as { worktree: string }).worktree),
          rootPath,
          files: [
            {
              relativePath: rootPath === '/old/root' ? 'old-target.ts' : 'new-target.ts',
              basename: rootPath === '/old/root' ? 'old-target.ts' : 'new-target.ts',
              kind: 'text'
            }
          ],
          totalCount: 1,
          truncated: false
        },
        _meta: { runtimeId: 'legacy-runtime' }
      })
    })

    const context = {
      target: { kind: 'environment' as const, environmentId: 'env-1' },
      worktreeId: 'folder-1'
    }
    await expect(
      searchRuntimeFilePaths({ ...context, worktreePath: '/old/root' }, { query: 'target' })
    ).resolves.toEqual({ files: ['old-target.ts'], truncated: false })
    await expect(
      searchRuntimeFilePaths({ ...context, worktreePath: '/new/root' }, { query: 'target' })
    ).resolves.toEqual({ files: ['new-target.ts'], truncated: false })
  })
})
