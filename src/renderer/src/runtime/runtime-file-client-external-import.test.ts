import { describe, expect, it } from 'vitest'
import { importExternalPathsToRuntime } from './runtime-file-import-client'
import {
  fsStageExternalPathsForRuntimeUpload,
  fsUploadExternalFileToRuntime,
  runtimeEnvironmentCall,
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

describe('runtime file client', () => {
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
          target: { kind: 'environment' as const, environmentId: 'env-1' },
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
          target: { kind: 'environment' as const, environmentId: 'env-1' },
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
})
