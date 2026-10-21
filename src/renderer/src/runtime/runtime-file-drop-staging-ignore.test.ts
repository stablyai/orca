import { describe, expect, it, vi } from 'vitest'
import { importExternalPathsToRuntime } from './runtime-file-import-client'
import {
  fsStageExternalPathsForRuntimeUpload,
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

const failedResponse = (id: string): unknown => ({
  id,
  ok: false,
  error: { code: 'permission_denied', message: 'read-only file system' },
  _meta: { runtimeId: 'remote-runtime' }
})

const statResponse = (id: string): unknown => ({
  id,
  ok: true,
  result: { size: 2, isDirectory: false, mtime: 1 },
  _meta: { runtimeId: 'remote-runtime' }
})

const CONTEXT = {
  target: { kind: 'environment' as const, environmentId: 'env-1' },
  worktreeId: 'wt-1',
  worktreePath: '/remote/repo'
}

const SSH_CONTEXT = {
  ...CONTEXT,
  expectedSshTargetId: 'target-1',
  expectedSshConnectionGeneration: 4
}

function stageOneFile(): void {
  fsStageExternalPathsForRuntimeUpload.mockResolvedValue({
    sources: [
      {
        sourcePath: '/Users/me/shot.png',
        status: 'staged',
        name: 'shot.png',
        kind: 'file',
        entries: [
          {
            relativePath: '',
            kind: 'file',
            byteLength: 3,
            inode: 7,
            deviceId: 66,
            modifiedAtMs: 1_700_000_000_000
          }
        ]
      }
    ]
  })
}

function calledMethods(): { method: string; params: unknown }[] {
  return runtimeEnvironmentCall.mock.calls.map(([args]) => ({
    method: String(args.method),
    params: args.params
  }))
}

describe('drop staging ignore file', () => {
  it('writes `.orca/drops/.gitignore` the first time a drop creates the folder', async () => {
    stageOneFile()
    runtimeEnvironmentCall
      .mockResolvedValueOnce(notFoundResponse('stat-orca-miss'))
      .mockResolvedValueOnce(okResponse('create-orca'))
      .mockResolvedValueOnce(notFoundResponse('stat-drops-miss'))
      .mockResolvedValueOnce(okResponse('create-drops'))
      .mockResolvedValueOnce(notFoundResponse('stat-ignore-miss'))
      .mockResolvedValueOnce(okResponse('write-ignore'))
      .mockResolvedValueOnce(notFoundResponse('stat-file-miss'))
      .mockResolvedValueOnce(okResponse('commit-upload'))
      .mockResolvedValueOnce(okResponse('delete-temp'))

    const { results } = await importExternalPathsToRuntime(
      SSH_CONTEXT,
      ['/Users/me/shot.png'],
      '/remote/repo/.orca/drops',
      { ensureDestinationDir: true }
    )

    expect(results).toEqual([
      expect.objectContaining({ status: 'imported', destPath: '/remote/repo/.orca/drops/shot.png' })
    ])
    const writes = calledMethods().filter((call) => call.method === 'files.write')
    expect(writes).toEqual([
      {
        method: 'files.write',
        params: expect.objectContaining({
          worktree: 'id:wt-1',
          relativePath: '.orca/drops/.gitignore',
          content: '*\n',
          expectedExecutionHostId: 'ssh:target-1',
          expectedSshTargetId: 'target-1',
          expectedSshConnectionGeneration: 4
        })
      }
    ])
    // The ignore file lands before the dropped file, so git never sees the file untracked.
    const methods = calledMethods().map((call) => call.method)
    expect(methods.indexOf('files.write')).toBeLessThan(methods.indexOf('files.commitUpload'))
  })

  it('leaves an existing ignore file alone', async () => {
    stageOneFile()
    runtimeEnvironmentCall
      .mockResolvedValueOnce(statResponse('stat-orca-hit'))
      .mockResolvedValueOnce(statResponse('stat-drops-hit'))
      .mockResolvedValueOnce(statResponse('stat-ignore-hit'))
      .mockResolvedValueOnce(notFoundResponse('stat-file-miss'))
      .mockResolvedValueOnce(okResponse('commit-upload'))
      .mockResolvedValueOnce(okResponse('delete-temp'))

    await importExternalPathsToRuntime(CONTEXT, ['/Users/me/shot.png'], '/remote/repo/.orca/drops')

    expect(calledMethods().some((call) => call.method === 'files.write')).toBe(false)
  })

  it('still uploads the drop when the ignore file cannot be written', async () => {
    stageOneFile()
    runtimeEnvironmentCall
      .mockResolvedValueOnce(statResponse('stat-orca-hit'))
      .mockResolvedValueOnce(statResponse('stat-drops-hit'))
      .mockResolvedValueOnce(notFoundResponse('stat-ignore-miss'))
      .mockResolvedValueOnce(failedResponse('write-ignore-denied'))
      .mockResolvedValueOnce(notFoundResponse('stat-file-miss'))
      .mockResolvedValueOnce(okResponse('commit-upload'))
      .mockResolvedValueOnce(okResponse('delete-temp'))

    const { results } = await importExternalPathsToRuntime(
      CONTEXT,
      ['/Users/me/shot.png'],
      '/remote/repo/.orca/drops'
    )

    expect(results).toEqual([expect.objectContaining({ status: 'imported' })])
  })

  it('recognizes the drops folder of a Windows worktree', async () => {
    stageOneFile()
    runtimeEnvironmentCall
      .mockResolvedValueOnce(statResponse('stat-orca-hit'))
      .mockResolvedValueOnce(statResponse('stat-drops-hit'))
      .mockResolvedValueOnce(notFoundResponse('stat-ignore-miss'))
      .mockResolvedValueOnce(okResponse('write-ignore'))
      .mockResolvedValueOnce(notFoundResponse('stat-file-miss'))
      .mockResolvedValueOnce(okResponse('commit-upload'))
      .mockResolvedValueOnce(okResponse('delete-temp'))

    await importExternalPathsToRuntime(
      { ...CONTEXT, worktreePath: 'C:\\Users\\me\\repo' },
      ['/Users/me/shot.png'],
      'C:\\Users\\me\\repo\\.orca\\drops'
    )

    expect(calledMethods().filter((call) => call.method === 'files.write')).toEqual([
      {
        method: 'files.write',
        params: expect.objectContaining({ relativePath: '.orca/drops/.gitignore', content: '*\n' })
      }
    ])
  })

  // Why: the ignore step swallows its own errors, and a drop with nothing staged never re-checks.
  it('reports a host that went stale during the ignore step even when nothing was staged', async () => {
    fsStageExternalPathsForRuntimeUpload.mockResolvedValue({
      sources: [{ sourcePath: '/Users/me/link.png', status: 'skipped', reason: 'symlink' }]
    })
    let stale = false
    runtimeEnvironmentCall
      .mockResolvedValueOnce(statResponse('stat-orca-hit'))
      .mockResolvedValueOnce(statResponse('stat-drops-hit'))
      .mockResolvedValueOnce(notFoundResponse('stat-ignore-miss'))
      .mockImplementationOnce(async () => {
        stale = true
        return okResponse('write-ignore')
      })
    const assertCurrent = vi.fn(() => {
      if (stale) {
        throw new Error('runtime owner generation changed')
      }
    })

    await expect(
      importExternalPathsToRuntime(CONTEXT, ['/Users/me/link.png'], '/remote/repo/.orca/drops', {
        assertCurrent
      })
    ).rejects.toThrow('runtime owner generation changed')
  })

  it('never writes an ignore file into a folder the user picked', async () => {
    stageOneFile()
    runtimeEnvironmentCall
      .mockResolvedValueOnce(statResponse('stat-uploads-hit'))
      .mockResolvedValueOnce(notFoundResponse('stat-file-miss'))
      .mockResolvedValueOnce(okResponse('commit-upload'))
      .mockResolvedValueOnce(okResponse('delete-temp'))

    await importExternalPathsToRuntime(CONTEXT, ['/Users/me/shot.png'], '/remote/repo/uploads')

    expect(calledMethods().some((call) => call.method === 'files.write')).toBe(false)
  })
})
