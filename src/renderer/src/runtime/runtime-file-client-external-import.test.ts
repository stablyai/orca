import { describe, expect, it, vi } from 'vitest'
import { importExternalPathsToRuntime } from './runtime-file-client'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import {
  fsImportExternalPaths,
  fsStageExternalPathsForRuntimeUpload,
  fsUploadExternalFileToRuntime,
  runtimeEnvironmentCall,
  runtimeEnvironmentTransportCall,
  installRuntimeFileClientEnvironment
} from './runtime-file-client-test-harness'

installRuntimeFileClientEnvironment()

const okResponse = (id: string): unknown => ({
  id,
  ok: true,
  result: { ok: true },
  _meta: { runtimeId: 'remote-runtime' }
})

const notFoundResponse = (id: string): unknown => ({
  id,
  ok: false,
  error: { code: 'not_found', message: 'not found' },
  _meta: { runtimeId: 'remote-runtime' }
})

/** Matches what main-process staging now records for a file entry. */
const stagedFile = (
  relativePath: string,
  byteLength: number,
  inode: number
): Record<string, unknown> => ({
  relativePath,
  kind: 'file',
  byteLength,
  inode,
  deviceId: 66,
  modifiedAtMs: 1_700_000_000_000
})

/** The upload request main receives; `never[]` mock args widen to it without a cast. */
type UploadRequest = {
  environmentId: string
  sourceRootPath: string
  entryRelativePath: string
  expected: Record<string, unknown>
  worktree: string
  relativePath: string
  expectedExecutionHostId?: string
  expectedSshTargetId?: string
  expectedSshConnectionGeneration?: number
  expectedEnvironmentPairingRevision?: number
  expectedEnvironmentRuntimeId?: string
}

function uploadRequests(): UploadRequest[] {
  return fsUploadExternalFileToRuntime.mock.calls.flat()
}

const identityOf = (entry: Record<string, unknown>): Record<string, unknown> => ({
  byteLength: entry.byteLength,
  inode: entry.inode,
  deviceId: entry.deviceId,
  modifiedAtMs: entry.modifiedAtMs
})

describe('runtime file client', () => {
  it('streams staged directory entries through main instead of sending base64 itself', async () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 17 }])
    const logo = stagedFile('logo.png', 3, 101)
    const large = stagedFile('large.bin', 40 * 1024 * 1024, 102)
    fsStageExternalPathsForRuntimeUpload.mockResolvedValue({
      sources: [
        {
          sourcePath: '/Users/me/assets',
          status: 'staged',
          name: 'assets',
          kind: 'directory',
          entries: [{ relativePath: '', kind: 'directory' }, logo, large]
        }
      ]
    })
    runtimeEnvironmentCall
      .mockResolvedValueOnce(notFoundResponse('stat-destination-miss'))
      .mockResolvedValueOnce(okResponse('create-destination-dir'))
      .mockResolvedValueOnce(notFoundResponse('stat-miss'))
      .mockResolvedValueOnce(okResponse('create-dir'))
      .mockResolvedValueOnce(okResponse('commit-upload'))
      .mockResolvedValueOnce(okResponse('delete-temp'))
      .mockResolvedValueOnce(okResponse('commit-large-upload'))
      .mockResolvedValueOnce(okResponse('delete-large-temp'))

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
    const transportCalls = runtimeEnvironmentTransportCall.mock.calls.map(([args]) => args)
    expect(transportCalls.map((args) => args.method)).toEqual([
      'status.get',
      'status.get',
      'files.stat',
      'files.createDir',
      'files.stat',
      'files.createDirNoClobber',
      'files.commitUpload',
      'files.delete',
      'files.commitUpload',
      'files.delete'
    ])
    // Why: the whole point of the change — no file body crosses this boundary.
    expect(transportCalls.some((args) => String(args.method).startsWith('files.writeBase64'))).toBe(
      false
    )
    expect(transportCalls.every((args) => args.expectedEnvironmentPairingRevision === 17)).toBe(
      true
    )

    const uploads = uploadRequests()
    expect(uploads).toHaveLength(2)
    expect(uploads[0]?.relativePath).toMatch(/^uploads\/assets\/\.logo\.png\.orca-upload-/)
    expect(uploads[0]).toEqual({
      environmentId: 'env-1',
      sourceRootPath: '/Users/me/assets',
      entryRelativePath: 'logo.png',
      expected: identityOf(logo),
      worktree: 'id:wt-1',
      relativePath: uploads[0]?.relativePath,
      expectedExecutionHostId: 'local',
      expectedSshTargetId: undefined,
      expectedSshConnectionGeneration: undefined,
      expectedEnvironmentPairingRevision: 17,
      expectedEnvironmentRuntimeId: 'remote-runtime'
    })
    expect(uploads[1]).toMatchObject({
      entryRelativePath: 'large.bin',
      expected: identityOf(large)
    })
    expect(uploads[1]?.relativePath).toMatch(/^uploads\/assets\/\.large\.bin\.orca-upload-/)

    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(5, {
      selector: 'env-1',
      method: 'files.commitUpload',
      params: {
        worktree: 'id:wt-1',
        tempRelativePath: uploads[0]?.relativePath,
        finalRelativePath: 'uploads/assets/logo.png',
        expectedExecutionHostId: 'local',
        expectedSshTargetId: undefined,
        expectedSshConnectionGeneration: undefined
      },
      timeoutMs: 30_000,
      expectedEnvironmentPairingRevision: 17,
      expectedEnvironmentRuntimeId: 'remote-runtime'
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(6, {
      selector: 'env-1',
      method: 'files.delete',
      params: {
        worktree: 'id:wt-1',
        relativePath: uploads[0]?.relativePath,
        recursive: false,
        expectedExecutionHostId: 'local',
        expectedSshTargetId: undefined,
        expectedSshConnectionGeneration: undefined
      },
      timeoutMs: 15_000,
      expectedEnvironmentPairingRevision: 17,
      expectedEnvironmentRuntimeId: 'remote-runtime'
    })
    expect(fsImportExternalPaths).not.toHaveBeenCalled()
  })

  it('forwards a single staged file with the identity staging measured', async () => {
    const entry = stagedFile('', 40 * 1024 * 1024, 55)
    fsStageExternalPathsForRuntimeUpload.mockResolvedValue({
      sources: [
        {
          sourcePath: '/Users/me/large.bin',
          status: 'staged',
          name: 'large.bin',
          kind: 'file',
          entries: [entry]
        }
      ]
    })
    runtimeEnvironmentCall
      .mockResolvedValueOnce(notFoundResponse('stat-destination-miss'))
      .mockResolvedValueOnce(okResponse('create-destination-dir'))
      .mockResolvedValueOnce(notFoundResponse('stat-miss'))
      .mockResolvedValueOnce(okResponse('commit-upload'))
      .mockResolvedValueOnce(okResponse('delete-temp'))

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

    const upload = uploadRequests()[0]
    expect(upload?.relativePath).toMatch(/^uploads\/\.large\.bin\.orca-upload-/)
    expect(upload?.sourceRootPath).toBe('/Users/me/large.bin')
    expect(upload?.entryRelativePath).toBe('')
    expect(upload?.expected).toEqual(identityOf(entry))
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.writeBase64' })
    )
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.writeBase64Chunk' })
    )
  })

  it('does not commit an upload when the owner generation changes while it streams', async () => {
    fsStageExternalPathsForRuntimeUpload.mockResolvedValue({
      sources: [
        {
          sourcePath: '/Users/me/large.bin',
          status: 'staged',
          name: 'large.bin',
          kind: 'file',
          entries: [stagedFile('', 40 * 1024 * 1024, 55)]
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
      .mockResolvedValueOnce(notFoundResponse('stat-file-miss'))
    let ownerChanged = false
    fsUploadExternalFileToRuntime.mockImplementation(async () => {
      ownerChanged = true
      return { byteLength: 40 * 1024 * 1024 }
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

    expect(runtimeEnvironmentCall.mock.calls.map((call) => call[0].method)).toEqual([
      'files.stat',
      'files.stat'
    ])
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.commitUpload' })
    )
  })

  it('cleans up the staged temp path when the streamed upload fails', async () => {
    fsStageExternalPathsForRuntimeUpload.mockResolvedValue({
      sources: [
        {
          sourcePath: '/Users/me/large.bin',
          status: 'staged',
          name: 'large.bin',
          kind: 'file',
          entries: [stagedFile('', 40 * 1024 * 1024, 55)]
        }
      ]
    })
    runtimeEnvironmentCall
      .mockResolvedValueOnce(notFoundResponse('stat-destination-miss'))
      .mockResolvedValueOnce(okResponse('create-destination-dir'))
      .mockResolvedValueOnce(notFoundResponse('stat-miss'))
      .mockResolvedValueOnce(okResponse('delete-temp'))
    // Electron wraps a main-process throw; the reason must not leak that.
    fsUploadExternalFileToRuntime.mockRejectedValue(
      new Error("Error invoking remote method 'fs:uploadExternalFileToRuntime': Error: disk full")
    )

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

    const tempRelativePath = uploadRequests()[0]?.relativePath
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.commitUpload' })
    )
    expect(runtimeEnvironmentCall).toHaveBeenLastCalledWith({
      selector: 'env-1',
      method: 'files.delete',
      params: {
        worktree: 'id:wt-1',
        relativePath: tempRelativePath,
        recursive: false,
        expectedExecutionHostId: 'local',
        expectedSshTargetId: undefined,
        expectedSshConnectionGeneration: undefined
      },
      timeoutMs: 15_000,
      expectedEnvironmentPairingRevision: undefined,
      expectedEnvironmentRuntimeId: 'remote-runtime'
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
          entries: [{ relativePath: '', kind: 'directory' }, stagedFile('logo.png', 3, 101)]
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
      .mockResolvedValueOnce(notFoundResponse('stat-import-root-miss'))
      .mockResolvedValueOnce(okResponse('create-import-root'))
      .mockResolvedValueOnce(okResponse('delete-temp'))
      .mockResolvedValueOnce(okResponse('delete-import-root'))
    fsUploadExternalFileToRuntime.mockRejectedValue(new Error('disk full'))

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

    expect(uploadRequests()[0]?.relativePath).toMatch(/^uploads\/assets\/\.logo\.png\.orca-upload-/)
    expect(runtimeEnvironmentCall).toHaveBeenLastCalledWith({
      selector: 'env-1',
      method: 'files.delete',
      params: {
        worktree: 'id:wt-1',
        relativePath: 'uploads/assets',
        recursive: true,
        expectedExecutionHostId: 'local'
      },
      timeoutMs: 15_000,
      expectedEnvironmentPairingRevision: undefined,
      expectedEnvironmentRuntimeId: 'remote-runtime'
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
    expect(fsUploadExternalFileToRuntime).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })
})
