import { describe, expect, it, vi } from 'vitest'
import { importExternalPathsToRuntime } from './runtime-file-client'
import {
  fsImportExternalPaths,
  fsStageExternalPathsForRuntimeUpload,
  fsUploadExternalFileToRuntime,
  runtimeEnvironmentCall,
  installRuntimeFileClientEnvironment
} from './runtime-file-client-test-harness'

installRuntimeFileClientEnvironment()

describe('runtime file client', () => {
  it('uploads staged local drops into the selected runtime environment', async () => {
    fsStageExternalPathsForRuntimeUpload.mockResolvedValue({
      sources: [
        {
          sourcePath: '/Users/me/assets',
          status: 'staged',
          name: 'assets',
          kind: 'directory',
          entries: [
            { relativePath: '', kind: 'directory' },
            { relativePath: 'logo.png', kind: 'file', byteLength: 3 }
          ]
        }
      ]
    })
    runtimeEnvironmentCall
      .mockResolvedValueOnce({
        id: 'stat-destination-miss',
        ok: false,
        error: { code: 'not_found', message: 'not found' },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'create-destination-dir',
        ok: true,
        result: { ok: true },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'stat-miss',
        ok: false,
        error: { code: 'not_found', message: 'not found' },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'create-dir',
        ok: true,
        result: { ok: true },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'commit-upload',
        ok: true,
        result: { ok: true },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'delete-temp',
        ok: true,
        result: { ok: true },
        _meta: { runtimeId: 'remote-runtime' }
      })

    await expect(
      importExternalPathsToRuntime(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo'
        },
        ['/Users/me/assets'],
        '/remote/repo/uploads'
      )
    ).resolves.toEqual({
      results: [
        {
          sourcePath: '/Users/me/assets',
          status: 'imported',
          destPath: '/remote/repo/uploads/assets',
          kind: 'directory',
          renamed: false
        }
      ]
    })

    expect(fsStageExternalPathsForRuntimeUpload).toHaveBeenCalledWith({
      sourcePaths: ['/Users/me/assets']
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(1, {
      selector: 'env-1',
      method: 'files.stat',
      params: {
        worktree: 'id:wt-1',
        relativePath: 'uploads'
      },
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(2, {
      selector: 'env-1',
      method: 'files.createDir',
      params: {
        worktree: 'id:wt-1',
        relativePath: 'uploads',
        expectedExecutionHostId: 'local'
      },
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(3, {
      selector: 'env-1',
      method: 'files.stat',
      params: {
        worktree: 'id:wt-1',
        relativePath: 'uploads/assets'
      },
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(4, {
      selector: 'env-1',
      method: 'files.createDirNoClobber',
      params: {
        worktree: 'id:wt-1',
        relativePath: 'uploads/assets',
        expectedExecutionHostId: 'local'
      },
      timeoutMs: 15_000
    })
    // Why: main streams the body, so the renderer hands over a source locator
    // and never issues a write RPC of its own.
    const uploadArgs = fsUploadExternalFileToRuntime.mock.calls[0]?.[0] as {
      relativePath: string
    }
    expect(uploadArgs.relativePath).toMatch(/^uploads\/assets\/\.logo\.png\.orca-upload-/)
    expect(uploadArgs).toMatchObject({
      environmentId: 'env-1',
      sourceRootPath: '/Users/me/assets',
      entryRelativePath: 'logo.png',
      worktree: 'id:wt-1',
      expectedExecutionHostId: 'local'
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(5, {
      selector: 'env-1',
      method: 'files.commitUpload',
      params: {
        worktree: 'id:wt-1',
        tempRelativePath: uploadArgs.relativePath,
        finalRelativePath: 'uploads/assets/logo.png',
        expectedExecutionHostId: 'local',
        expectedSshTargetId: undefined,
        expectedSshConnectionGeneration: undefined
      },
      timeoutMs: 30_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(6, {
      selector: 'env-1',
      method: 'files.delete',
      params: {
        worktree: 'id:wt-1',
        relativePath: uploadArgs.relativePath,
        recursive: false,
        expectedExecutionHostId: 'local',
        expectedSshTargetId: undefined,
        expectedSshConnectionGeneration: undefined
      },
      timeoutMs: 15_000
    })
    expect(fsImportExternalPaths).not.toHaveBeenCalled()
  })

  it('delegates the whole body to main instead of chunking it in the renderer', async () => {
    fsStageExternalPathsForRuntimeUpload.mockResolvedValue({
      sources: [
        {
          sourcePath: '/Users/me/large.bin',
          status: 'staged',
          name: 'large.bin',
          kind: 'file',
          entries: [{ relativePath: '', kind: 'file', byteLength: 64 * 1024 * 1024 }]
        }
      ]
    })
    runtimeEnvironmentCall
      .mockResolvedValueOnce({
        id: 'stat-destination-miss',
        ok: false,
        error: { code: 'not_found', message: 'not found' },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'create-destination-dir',
        ok: true,
        result: { ok: true },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'stat-miss',
        ok: false,
        error: { code: 'not_found', message: 'not found' },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'commit-upload',
        ok: true,
        result: { ok: true },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'delete-temp',
        ok: true,
        result: { ok: true },
        _meta: { runtimeId: 'remote-runtime' }
      })

    await expect(
      importExternalPathsToRuntime(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo'
        },
        ['/Users/me/large.bin'],
        '/remote/repo/uploads'
      )
    ).resolves.toEqual({
      results: [
        {
          sourcePath: '/Users/me/large.bin',
          status: 'imported',
          destPath: '/remote/repo/uploads/large.bin',
          kind: 'file',
          renamed: false
        }
      ]
    })

    // Why: a file far over the former 25 MB cap imports with one upload call and
    // no renderer-held content; slicing is covered in runtime-upload-file-stream.
    expect(fsUploadExternalFileToRuntime).toHaveBeenCalledTimes(1)
    const uploadArgs = fsUploadExternalFileToRuntime.mock.calls[0]?.[0] as {
      relativePath: string
    }
    expect(uploadArgs.relativePath).toMatch(/^uploads\/\.large\.bin\.orca-upload-/)
    expect(uploadArgs).toMatchObject({
      sourceRootPath: '/Users/me/large.bin',
      entryRelativePath: ''
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.writeBase64' })
    )
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.writeBase64Chunk' })
    )
  })

  it('stops an upload when its owner generation changes during the transfer', async () => {
    fsStageExternalPathsForRuntimeUpload.mockResolvedValue({
      sources: [
        {
          sourcePath: '/Users/me/large.bin',
          status: 'staged',
          name: 'large.bin',
          kind: 'file',
          entries: [{ relativePath: '', kind: 'file', byteLength: 512 * 1024 }]
        }
      ]
    })
    runtimeEnvironmentCall
      .mockResolvedValueOnce({
        id: 'stat-destination',
        ok: true,
        result: { size: 0, isDirectory: true, mtime: 1 },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'stat-file-miss',
        ok: false,
        error: { code: 'not_found', message: 'not found' },
        _meta: { runtimeId: 'remote-runtime' }
      })
    let ownerChanged = false
    fsUploadExternalFileToRuntime.mockImplementation(async () => {
      ownerChanged = true
      return { byteLength: 512 * 1024 }
    })
    const assertCurrent = vi.fn(() => {
      if (ownerChanged) {
        throw new Error('runtime owner generation changed')
      }
    })

    await expect(
      importExternalPathsToRuntime(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo'
        },
        ['/Users/me/large.bin'],
        '/remote/repo/uploads',
        { assertCurrent }
      )
    ).resolves.toMatchObject({
      results: [{ status: 'failed', reason: 'runtime owner generation changed' }]
    })

    // Why: the owner is re-checked after the transfer, so a changed owner never
    // reaches commit or cleanup.
    expect(runtimeEnvironmentCall.mock.calls.map((call) => call[0].method)).toEqual([
      'files.stat',
      'files.stat'
    ])
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.commitUpload' })
    )
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.delete' })
    )
  })

  it('cleans up the staged runtime upload temp file when the transfer fails', async () => {
    fsStageExternalPathsForRuntimeUpload.mockResolvedValue({
      sources: [
        {
          sourcePath: '/Users/me/large.bin',
          status: 'staged',
          name: 'large.bin',
          kind: 'file',
          entries: [{ relativePath: '', kind: 'file', byteLength: 512 * 1024 }]
        }
      ]
    })
    fsUploadExternalFileToRuntime.mockRejectedValue(new Error('disk full'))
    runtimeEnvironmentCall
      .mockResolvedValueOnce({
        id: 'stat-destination-miss',
        ok: false,
        error: { code: 'not_found', message: 'not found' },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'create-destination-dir',
        ok: true,
        result: { ok: true },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'stat-miss',
        ok: false,
        error: { code: 'not_found', message: 'not found' },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'delete-temp',
        ok: true,
        result: { ok: true },
        _meta: { runtimeId: 'remote-runtime' }
      })

    await expect(
      importExternalPathsToRuntime(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo'
        },
        ['/Users/me/large.bin'],
        '/remote/repo/uploads'
      )
    ).resolves.toMatchObject({
      results: [{ status: 'failed', reason: 'disk full' }]
    })

    const uploadArgs = fsUploadExternalFileToRuntime.mock.calls[0]?.[0] as
      | { relativePath: string }
      | undefined
    if (!uploadArgs) {
      throw new Error('missing upload call')
    }
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.commitUpload' })
    )
    expect(runtimeEnvironmentCall).toHaveBeenLastCalledWith({
      selector: 'env-1',
      method: 'files.delete',
      params: {
        worktree: 'id:wt-1',
        relativePath: uploadArgs.relativePath,
        recursive: false,
        expectedExecutionHostId: 'local',
        expectedSshTargetId: undefined,
        expectedSshConnectionGeneration: undefined
      },
      timeoutMs: 15_000
    })
  })

  it('removes a created runtime directory import root when a nested file upload fails', async () => {
    fsStageExternalPathsForRuntimeUpload.mockResolvedValue({
      sources: [
        {
          sourcePath: '/Users/me/assets',
          status: 'staged',
          name: 'assets',
          kind: 'directory',
          entries: [
            { relativePath: '', kind: 'directory' },
            { relativePath: 'logo.png', kind: 'file', byteLength: 3 }
          ]
        }
      ]
    })
    fsUploadExternalFileToRuntime.mockRejectedValue(new Error('disk full'))
    runtimeEnvironmentCall
      .mockResolvedValueOnce({
        id: 'stat-destination',
        ok: true,
        result: { size: 0, isDirectory: true, mtime: 1 },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'stat-import-root-miss',
        ok: false,
        error: { code: 'not_found', message: 'not found' },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'create-import-root',
        ok: true,
        result: { ok: true },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'delete-temp',
        ok: true,
        result: { ok: true },
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'delete-import-root',
        ok: true,
        result: { ok: true },
        _meta: { runtimeId: 'remote-runtime' }
      })

    await expect(
      importExternalPathsToRuntime(
        {
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo'
        },
        ['/Users/me/assets'],
        '/remote/repo/uploads'
      )
    ).resolves.toMatchObject({
      results: [{ status: 'failed', reason: 'disk full' }]
    })

    const uploadArgs = fsUploadExternalFileToRuntime.mock.calls[0]?.[0] as
      | { relativePath: string }
      | undefined
    if (!uploadArgs) {
      throw new Error('missing failed file upload call')
    }
    expect(uploadArgs.relativePath).toMatch(/^uploads\/assets\/\.logo\.png\.orca-upload-/)
    expect(runtimeEnvironmentCall).toHaveBeenLastCalledWith({
      selector: 'env-1',
      method: 'files.delete',
      params: {
        worktree: 'id:wt-1',
        relativePath: 'uploads/assets',
        recursive: true,
        expectedExecutionHostId: 'local'
      },
      timeoutMs: 15_000
    })
  })

  it('keeps local external imports on filesystem IPC when no runtime is active', async () => {
    fsImportExternalPaths.mockResolvedValue({
      results: [
        {
          sourcePath: '/Users/me/readme.md',
          status: 'imported',
          destPath: '/repo/readme.md',
          kind: 'file',
          renamed: false
        }
      ]
    })

    await importExternalPathsToRuntime(
      {
        settings: { activeRuntimeEnvironmentId: null },
        worktreeId: 'wt-1',
        worktreePath: '/repo',
        connectionId: 'ssh-1',
        expectedSshTargetId: 'ssh-1',
        expectedSshConnectionGeneration: 5
      },
      ['/Users/me/readme.md'],
      '/repo',
      { ensureDestinationDir: true }
    )

    expect(fsImportExternalPaths).toHaveBeenCalledWith({
      sourcePaths: ['/Users/me/readme.md'],
      destDir: '/repo',
      connectionId: 'ssh-1',
      expectedExecutionHostId: 'ssh:ssh-1',
      ensureDir: true,
      expectedSshTargetId: 'ssh-1',
      expectedSshConnectionGeneration: 5
    })
    expect(fsStageExternalPathsForRuntimeUpload).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })
})
