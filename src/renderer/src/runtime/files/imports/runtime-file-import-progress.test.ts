import { describe, expect, it, vi } from 'vitest'
import { importExternalPathsToRuntime } from './runtime-file-import-client'
import {
  fsReleaseRuntimeUpload,
  fsStageExternalPathsForRuntimeUpload,
  fsUploadExternalFileToRuntime,
  runtimeEnvironmentCall,
  runtimeEnvironmentTransportCall,
  installRuntimeFileClientEnvironment
} from '../runtime-file-client-test-harness'
import { getRuntimeEnvironmentStatus } from '../../rpc/compatibility/runtime-compatibility-probe'
import type { RuntimeImportProgressHandlers } from './runtime-upload-progress-tracker'
import type { ImportItemResult } from '../../../../../shared/file-import/filesystem-import-result'

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
  uploadId?: string
  fileSequence?: number
  expectedExecutionHostId?: string
  expectedSshTargetId?: string
  expectedSshConnectionGeneration?: number
  expectedEnvironmentPairingRevision?: number
  expectedEnvironmentRuntimeId?: string
}

function uploadRequests(): UploadRequest[] {
  return fsUploadExternalFileToRuntime.mock.calls.flat()
}

function quietHandlers(): RuntimeImportProgressHandlers {
  return { onStart: vi.fn(), onRowProgress: vi.fn(), onRowSettled: vi.fn(), onFinish: vi.fn() }
}

/** One staged file whose upload rejects with `error` after the user clicked Cancel on its row. */
async function importFileThatThrowsAfterCancel(
  error: string,
  progress: RuntimeImportProgressHandlers = quietHandlers()
): Promise<ImportItemResult[]> {
  fsStageExternalPathsForRuntimeUpload.mockResolvedValue({
    sources: [
      {
        sourcePath: '/Users/me/clip.mp4',
        status: 'staged',
        name: 'clip.mp4',
        kind: 'file',
        entries: [stagedFile('', 10, 7)]
      }
    ]
  })
  runtimeEnvironmentCall.mockImplementation(async (call: { method: string }) =>
    call.method === 'files.stat' ? notFoundResponse('stat-miss') : okResponse('ok')
  )
  fsUploadExternalFileToRuntime.mockRejectedValueOnce(new Error(error))
  const { results } = await importExternalPathsToRuntime(
    {
      target: { kind: 'environment' as const, environmentId: 'env-1' },
      worktreeId: 'wt-1',
      worktreePath: '/remote/repo'
    },
    ['/Users/me/clip.mp4'],
    '/remote/repo/uploads',
    { progress: { ...progress, isCancelled: () => true } }
  )
  return results
}

describe('runtime file import progress and cancel', () => {
  it('settles and releases each row when the drop reports progress', async () => {
    fsStageExternalPathsForRuntimeUpload.mockResolvedValue({
      sources: [
        {
          sourcePath: '/Users/me/logo.png',
          status: 'staged',
          name: 'logo.png',
          kind: 'file',
          entries: [stagedFile('', 3, 55)]
        }
      ]
    })
    runtimeEnvironmentCall
      .mockResolvedValueOnce(notFoundResponse('stat-destination-miss'))
      .mockResolvedValueOnce(okResponse('create-destination-dir'))
      .mockResolvedValueOnce(notFoundResponse('stat-miss'))
      .mockResolvedValueOnce(okResponse('commit-upload'))
      .mockResolvedValueOnce(okResponse('delete-temp'))
    const progress = {
      onStart: vi.fn<RuntimeImportProgressHandlers['onStart']>(),
      onRowProgress: vi.fn<RuntimeImportProgressHandlers['onRowProgress']>(),
      onRowSettled: vi.fn<RuntimeImportProgressHandlers['onRowSettled']>(),
      onFinish: vi.fn<RuntimeImportProgressHandlers['onFinish']>()
    }

    await expect(
      importExternalPathsToRuntime(
        {
          target: { kind: 'environment' as const, environmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo'
        },
        ['/Users/me/logo.png'],
        '/remote/repo/uploads',
        { progress }
      )
    ).resolves.toMatchObject({ results: [{ status: 'imported' }] })

    const uploadId = progress.onStart.mock.calls[0]?.[0][0]?.uploadId
    expect(uploadId).toEqual(expect.any(String))
    expect(progress.onRowProgress).toHaveBeenLastCalledWith(uploadId, 3)
    expect(progress.onRowSettled).toHaveBeenCalledWith(uploadId, 'done')
    expect(progress.onFinish).toHaveBeenCalledTimes(1)
    expect(fsReleaseRuntimeUpload).toHaveBeenCalledWith({ uploadId })
    // Why: a release that raced ahead of a later file's stream would forget that file's cancel.
    const lastUpload = Math.max(...fsUploadExternalFileToRuntime.mock.invocationCallOrder)
    expect(fsReleaseRuntimeUpload.mock.invocationCallOrder[0]).toBeGreaterThan(lastUpload)
  })

  it('gives each copy of a path dropped twice its own row and file sequence', async () => {
    const logo = {
      sourcePath: '/Users/me/logo.png',
      status: 'staged',
      name: 'logo.png',
      kind: 'file',
      entries: [stagedFile('', 3, 55)]
    }
    fsStageExternalPathsForRuntimeUpload.mockResolvedValue({ sources: [logo, logo] })
    runtimeEnvironmentCall
      .mockResolvedValueOnce(notFoundResponse('stat-destination-miss'))
      .mockResolvedValueOnce(okResponse('create-destination-dir'))
      .mockResolvedValueOnce(notFoundResponse('stat-miss'))
      .mockResolvedValueOnce(okResponse('commit-upload'))
      .mockResolvedValueOnce(okResponse('delete-temp'))
      // The copy first finds `logo.png` reserved by the first, then takes `logo copy.png`.
      .mockResolvedValueOnce(notFoundResponse('stat-name-miss'))
      .mockResolvedValueOnce(notFoundResponse('stat-copy-miss'))
      .mockResolvedValueOnce(okResponse('commit-copy'))
      .mockResolvedValueOnce(okResponse('delete-copy-temp'))
    const progress = {
      onStart: vi.fn<RuntimeImportProgressHandlers['onStart']>(),
      onRowProgress: vi.fn<RuntimeImportProgressHandlers['onRowProgress']>(),
      onRowSettled: vi.fn<RuntimeImportProgressHandlers['onRowSettled']>(),
      onFinish: vi.fn<RuntimeImportProgressHandlers['onFinish']>()
    }

    await importExternalPathsToRuntime(
      {
        target: { kind: 'environment' as const, environmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/remote/repo'
      },
      ['/Users/me/logo.png', '/Users/me/logo.png'],
      '/remote/repo/uploads',
      { progress }
    )

    const rowIds = progress.onStart.mock.calls[0]?.[0].map((row) => row.uploadId)
    expect(new Set(rowIds).size).toBe(2)
    expect(uploadRequests().map((request) => request.uploadId)).toEqual(rowIds)
    expect(uploadRequests().map((request) => request.fileSequence)).toEqual([0, 1])
    expect(progress.onRowSettled.mock.calls).toEqual([
      [rowIds?.[0], 'done'],
      [rowIds?.[1], 'done']
    ])
  })

  it('stops a cancelled source of empty directories and removes its root', async () => {
    fsStageExternalPathsForRuntimeUpload.mockResolvedValue({
      sources: [
        {
          sourcePath: '/Users/me/empty',
          status: 'staged',
          name: 'empty',
          kind: 'directory',
          entries: [
            { relativePath: '', kind: 'directory' },
            { relativePath: 'nested', kind: 'directory' }
          ]
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
      .mockResolvedValueOnce(okResponse('delete-import-root'))
    // The user cancels after the root exists, before the nested directory.
    const isCancelled = vi.fn<(uploadId: string) => boolean>(() =>
      runtimeEnvironmentCall.mock.calls.some(([call]) => call.method === 'files.createDirNoClobber')
    )

    await expect(
      importExternalPathsToRuntime(
        {
          target: { kind: 'environment' as const, environmentId: 'env-1' },
          worktreeId: 'wt-1',
          worktreePath: '/remote/repo'
        },
        ['/Users/me/empty'],
        '/remote/repo/uploads',
        {
          progress: {
            onStart: vi.fn(),
            onRowProgress: vi.fn(),
            onRowSettled: vi.fn(),
            onFinish: vi.fn(),
            isCancelled
          }
        }
      )
    ).resolves.toMatchObject({
      results: [{ status: 'failed', reason: 'Upload cancelled', cancelled: true }]
    })

    const methods = runtimeEnvironmentCall.mock.calls.map(([call]) => call.method)
    expect(methods.filter((method) => method === 'files.createDirNoClobber')).toHaveLength(1)
    expect(runtimeEnvironmentCall).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: 'files.delete',
        params: expect.objectContaining({ relativePath: 'uploads/empty', recursive: true })
      })
    )
  })

  it('stops an empty folder whose cancel lands while its last directory is being created', async () => {
    fsStageExternalPathsForRuntimeUpload.mockResolvedValue({
      sources: [
        {
          sourcePath: '/Users/me/empty',
          status: 'staged',
          name: 'empty',
          kind: 'directory',
          entries: [{ relativePath: '', kind: 'directory' }]
        }
      ]
    })
    let cancelled = false
    runtimeEnvironmentCall.mockImplementation(async (call: { method: string }) => {
      if (call.method === 'files.createDirNoClobber') {
        cancelled = true
        return okResponse('create-import-root')
      }
      return call.method === 'files.stat' ? notFoundResponse('stat-miss') : okResponse('ok')
    })

    const { results } = await importExternalPathsToRuntime(
      {
        target: { kind: 'environment' as const, environmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/remote/repo'
      },
      ['/Users/me/empty'],
      '/remote/repo/uploads',
      { progress: { ...quietHandlers(), isCancelled: () => cancelled } }
    )

    expect(results).toEqual([
      {
        sourcePath: '/Users/me/empty',
        status: 'failed',
        reason: 'Upload cancelled',
        cancelled: true
      }
    ])
    expect(runtimeEnvironmentCall).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: 'files.delete',
        params: expect.objectContaining({ relativePath: 'uploads/empty' })
      })
    )
  })

  it('creates nothing on the runtime when cancel lands before the first directory', async () => {
    fsStageExternalPathsForRuntimeUpload.mockResolvedValue({
      sources: [
        {
          sourcePath: '/Users/me/empty',
          status: 'staged',
          name: 'empty',
          kind: 'directory',
          entries: [{ relativePath: '', kind: 'directory' }]
        }
      ]
    })
    runtimeEnvironmentCall.mockImplementation(async (call: { method: string }) =>
      call.method === 'files.stat' ? notFoundResponse('stat-miss') : okResponse('ok')
    )

    const { results } = await importExternalPathsToRuntime(
      {
        target: { kind: 'environment' as const, environmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/remote/repo'
      },
      ['/Users/me/empty'],
      '/remote/repo/uploads',
      { progress: { ...quietHandlers(), isCancelled: () => true } }
    )

    expect(results[0]).toMatchObject({ status: 'failed', cancelled: true })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.createDirNoClobber' })
    )
  })

  it('marks a cancelled file cancelled through the IPC error wrapper', async () => {
    const [result] = await importFileThatThrowsAfterCancel(
      "Error invoking remote method 'fs:uploadExternalFileToRuntime': RuntimeUploadCancelledError: Upload cancelled"
    )

    expect(result).toMatchObject({ status: 'failed', cancelled: true })
  })

  it('reports a failure that came after the cancel click as a failure', async () => {
    const [result] = await importFileThatThrowsAfterCancel(
      "Error invoking remote method 'fs:uploadExternalFileToRuntime': Error: Remote connection dropped"
    )

    expect(result?.status).toBe('failed')
    expect(result).not.toHaveProperty('cancelled')
  })

  it('settles the row as cancelled only when the cancel is what stopped it', async () => {
    const cancelledRow = quietHandlers()
    await importFileThatThrowsAfterCancel('Upload cancelled', cancelledRow)
    const failedRow = quietHandlers()
    await importFileThatThrowsAfterCancel('Remote connection dropped', failedRow)

    expect(cancelledRow.onRowSettled).toHaveBeenCalledWith(expect.any(String), 'cancelled')
    expect(failedRow.onRowSettled).toHaveBeenCalledWith(expect.any(String), 'failed')
    expect(failedRow.onRowSettled).not.toHaveBeenCalledWith(expect.any(String), 'cancelled')
  })

  it('does not commit a file whose cancel lands after its stream resolved', async () => {
    fsStageExternalPathsForRuntimeUpload.mockResolvedValue({
      sources: [
        {
          sourcePath: '/Users/me/clip.mp4',
          status: 'staged',
          name: 'clip.mp4',
          kind: 'file',
          entries: [stagedFile('', 10, 7)]
        }
      ]
    })
    runtimeEnvironmentCall.mockImplementation(async (call: { method: string }) =>
      call.method === 'files.stat' ? notFoundResponse('stat-miss') : okResponse('ok')
    )
    let cancelled = false
    fsUploadExternalFileToRuntime.mockImplementation(() => {
      const streamed = Promise.resolve({ byteLength: 10 })
      // Registered before the client's await, so the cancel lands between stream and commit.
      void streamed.then(() => {
        cancelled = true
      })
      return streamed
    })
    const progress = { ...quietHandlers(), isCancelled: () => cancelled }

    const { results } = await importExternalPathsToRuntime(
      {
        target: { kind: 'environment' as const, environmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/remote/repo'
      },
      ['/Users/me/clip.mp4'],
      '/remote/repo/uploads',
      { progress }
    )

    expect(results).toEqual([
      {
        sourcePath: '/Users/me/clip.mp4',
        status: 'failed',
        reason: 'Upload cancelled',
        cancelled: true
      }
    ])
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.commitUpload' })
    )
    expect(runtimeEnvironmentCall).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: 'files.delete',
        params: expect.objectContaining({
          relativePath: uploadRequests()[0]?.relativePath,
          recursive: false
        })
      })
    )
    expect(progress.onRowSettled).toHaveBeenCalledWith(expect.any(String), 'cancelled')
  })

  it('does not commit a file whose cancel lands while the commit waits on a status probe', async () => {
    fsStageExternalPathsForRuntimeUpload.mockResolvedValue({
      sources: [
        {
          sourcePath: '/Users/me/clip.mp4',
          status: 'staged',
          name: 'clip.mp4',
          kind: 'file',
          entries: [stagedFile('', 10, 7)]
        }
      ]
    })
    runtimeEnvironmentCall.mockImplementation(async (call: { method: string }) =>
      call.method === 'files.stat' ? notFoundResponse('stat-miss') : okResponse('ok')
    )
    let releaseProbe = (): void => {}
    let streamed = false
    fsUploadExternalFileToRuntime.mockImplementation(async () => {
      // Another caller re-probes the runtime, so the commit has to wait on this pending status.get.
      const answerStatus = runtimeEnvironmentTransportCall.getMockImplementation()
      runtimeEnvironmentTransportCall.mockImplementationOnce(
        (request) =>
          new Promise((resolve) => {
            releaseProbe = () => resolve(answerStatus?.(request))
          })
      )
      void getRuntimeEnvironmentStatus('env-1')
      streamed = true
      return { byteLength: 10 }
    })
    let cancelled = false
    // The import checks its caller before every runtime call, and after the stream that is the
    // commit. Once the commit waits on the probe, the user cancels and then the probe answers.
    const assertCurrent = (): void => {
      if (streamed) {
        streamed = false
        queueMicrotask(() => {
          cancelled = true
          releaseProbe()
        })
      }
    }
    const progress = { ...quietHandlers(), isCancelled: () => cancelled }

    const { results } = await importExternalPathsToRuntime(
      {
        target: { kind: 'environment' as const, environmentId: 'env-1' },
        worktreeId: 'wt-1',
        worktreePath: '/remote/repo'
      },
      ['/Users/me/clip.mp4'],
      '/remote/repo/uploads',
      { progress, assertCurrent }
    )

    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.commitUpload' })
    )
    expect(results).toEqual([
      {
        sourcePath: '/Users/me/clip.mp4',
        status: 'failed',
        reason: 'Upload cancelled',
        cancelled: true
      }
    ])
    expect(runtimeEnvironmentCall).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: 'files.delete',
        params: expect.objectContaining({
          relativePath: uploadRequests()[0]?.relativePath,
          recursive: false
        })
      })
    )
    expect(progress.onRowSettled).toHaveBeenCalledWith(expect.any(String), 'cancelled')
  })
})
