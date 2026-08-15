import { describe, expect, it } from 'vitest'
import {
  cancelRuntimeFileList,
  listRuntimeFiles,
  listRuntimeMarkdownDocuments,
  runtimePathExists,
  searchRuntimeFiles,
  statRuntimePath
} from './runtime-file-client'
import {
  fsStat,
  fsPathExists,
  fsSearch,
  fsListFiles,
  fsCancelListFiles,
  runtimeEnvironmentCall,
  installRuntimeFileClientEnvironment
} from './runtime-file-client-test-harness'

installRuntimeFileClientEnvironment()

describe('runtime file client', () => {
  it('routes text search through the selected runtime without sending client root paths', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: { files: [], totalMatches: 0, truncated: false },
      _meta: { runtimeId: 'remote-runtime' }
    })

    await expect(
      searchRuntimeFiles(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo'
        },
        {
          query: 'needle',
          rootPath: '/remote/repo',
          caseSensitive: true,
          maxResults: 50
        }
      )
    ).resolves.toEqual({ files: [], totalMatches: 0, truncated: false })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'files.search',
      params: { worktree: 'id:wt-1', query: 'needle', caseSensitive: true, maxResults: 50 },
      timeoutMs: 15_000
    })
  })

  it('rejects oversized text search input before local IPC or runtime RPC', async () => {
    const oversizedQuery = 'x'.repeat(9 * 1024)

    await expect(
      searchRuntimeFiles(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo'
        },
        {
          query: oversizedQuery,
          rootPath: '/remote/repo',
          maxResults: 50
        }
      )
    ).resolves.toEqual({ files: [], totalMatches: 0, truncated: false })

    await expect(
      searchRuntimeFiles(
        {
          settings: { activeRuntimeEnvironmentId: null },
          worktreeId: 'wt-1',
          worktreePath: '/repo',
          connectionId: 'ssh-1'
        },
        {
          query: 'needle',
          rootPath: '/repo',
          includePattern: 'secret-token-value'.repeat(1024),
          maxResults: 50
        }
      )
    ).resolves.toEqual({ files: [], totalMatches: 0, truncated: false })

    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(fsSearch).not.toHaveBeenCalled()
  })

  it('routes quick-open file listing through the selected runtime', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: ['src/index.ts'],
      _meta: { runtimeId: 'remote-runtime' }
    })

    await expect(
      listRuntimeFiles(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo'
        },
        {
          rootPath: '/remote/repo',
          excludePaths: ['/remote/repo-other']
        }
      )
    ).resolves.toEqual(['src/index.ts'])

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'files.listAll',
      params: { worktree: 'id:wt-1', excludePaths: ['/remote/repo-other'] },
      timeoutMs: 15_000
    })
  })

  it('passes the cancellation token through the IPC file listing path (#7721)', async () => {
    fsListFiles.mockResolvedValue(['src/index.ts'])

    await expect(
      listRuntimeFiles(
        {
          settings: {},
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo',
          connectionId: 'ssh-1'
        },
        {
          rootPath: '/remote/repo',
          requestToken: 'token-1'
        }
      )
    ).resolves.toEqual(['src/index.ts'])

    expect(fsListFiles).toHaveBeenCalledWith({
      rootPath: '/remote/repo',
      connectionId: 'ssh-1',
      excludePaths: undefined,
      requestToken: 'token-1'
    })
  })

  it('cancelRuntimeFileList aborts the IPC listing but not environment listings (#7721)', () => {
    cancelRuntimeFileList(
      {
        settings: {},
        worktreeId: 'wt-1',
        worktreePath: '/remote/repo',
        connectionId: 'ssh-1'
      },
      'token-1'
    )
    expect(fsCancelListFiles).toHaveBeenCalledWith({ requestToken: 'token-1' })

    fsCancelListFiles.mockClear()
    cancelRuntimeFileList(
      {
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/remote/repo'
      },
      'token-2'
    )
    expect(fsCancelListFiles).not.toHaveBeenCalled()
  })

  it('routes markdown document listing and stat through the selected runtime', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: [{ relativePath: 'readme.md' }],
      _meta: { runtimeId: 'remote-runtime' }
    })
    const context = {
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      worktreeId: 'wt-1',
      worktreePath: '/remote/repo'
    }

    await listRuntimeMarkdownDocuments(context, '/remote/repo')
    await statRuntimePath(context, '/remote/repo/readme.md')

    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(1, {
      selector: 'env-1',
      method: 'files.listMarkdownDocuments',
      params: { worktree: 'id:wt-1' },
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(2, {
      selector: 'env-1',
      method: 'files.stat',
      params: { worktree: 'id:wt-1', relativePath: 'readme.md' },
      timeoutMs: 15_000
    })
  })

  it('uses quiet local path existence checks when no runtime environment is active', async () => {
    fsPathExists.mockResolvedValueOnce(false)

    await expect(
      runtimePathExists(
        {
          settings: { activeRuntimeEnvironmentId: null },
          worktreeId: 'wt-1',
          worktreePath: '/repo',
          connectionId: 'ssh-1'
        },
        '/repo/untitled.md'
      )
    ).resolves.toBe(false)

    expect(fsPathExists).toHaveBeenCalledWith({
      filePath: '/repo/untitled.md',
      connectionId: 'ssh-1'
    })
    expect(fsStat).not.toHaveBeenCalled()
  })

  it('does not fall back to client-local stat for remote-owned paths outside the worktree', async () => {
    await expect(
      statRuntimePath(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo'
        },
        '/tmp/readme.md'
      )
    ).rejects.toThrow('outside the owning runtime worktree')

    await expect(
      statRuntimePath(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: 'C:\\repo'
        },
        '\\\\server\\share\\repo\\readme.md'
      )
    ).rejects.toThrow('outside the owning runtime worktree')

    expect(fsStat).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })
})
