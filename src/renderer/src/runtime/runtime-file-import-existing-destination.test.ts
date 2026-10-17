import { beforeEach, expect, it } from 'vitest'
import { importExternalPathsToRuntime } from './runtime-file-import-client'
import {
  FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY,
  FILE_UPLOAD_EXISTING_PARENT_RUNTIME_CAPABILITY,
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'
import {
  fsImportExternalPaths,
  fsStageExternalPathsForRuntimeUpload,
  fsUploadExternalFileToRuntime,
  installRuntimeFileClientEnvironment,
  runtimeEnvironmentCall,
  runtimeEnvironmentTransportCall
} from './runtime-file-client-test-harness'

installRuntimeFileClientEnvironment()
const context = {
  target: { kind: 'environment', environmentId: 'env-1' } as const,
  worktreeId: 'folder:notes',
  worktreePath: '/remote/notes'
}
let capabilities: string[]
beforeEach(() => {
  capabilities = [
    FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY,
    FILE_UPLOAD_EXISTING_PARENT_RUNTIME_CAPABILITY
  ]
  runtimeEnvironmentTransportCall.mockImplementation((args) => {
    if (args.method === 'status.get') {
      return Promise.resolve({
        id: 'status',
        ok: true,
        result: {
          runtimeId: 'remote-runtime',
          runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
          minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
          capabilities
        },
        _meta: { runtimeId: 'remote-runtime' }
      })
    }
    return runtimeEnvironmentCall(args)
  })
  fsStageExternalPathsForRuntimeUpload.mockResolvedValue({
    sources: [
      {
        sourcePath: '/staging/pasted-image.png',
        status: 'staged',
        name: 'pasted-image.png',
        kind: 'file',
        entries: [
          { relativePath: '', kind: 'file', byteLength: 4, inode: 1, deviceId: 1, modifiedAtMs: 1 }
        ]
      }
    ]
  })
  runtimeEnvironmentCall.mockImplementation(async ({ method }) => ({
    id: 'response',
    ok: method !== 'files.stat',
    result: { ok: true },
    error: { code: 'not_found', message: 'not found' },
    _meta: { runtimeId: 'remote-runtime' }
  }))
})

const paste = (destination = '/remote/notes/images') =>
  importExternalPathsToRuntime(context, ['/staging/pasted-image.png'], destination, {
    requireExistingDestination: true
  })

it.each(['/remote/notes/images', '/remote/notes'])(
  'requires existing parents through upload and commit (%s)',
  async (destination) => {
    expect((await paste(destination)).results[0].status).toBe('imported')
    expect(fsUploadExternalFileToRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        requireExistingParent: true,
        worktree: 'id:folder:notes',
        expectedEnvironmentRuntimeId: 'remote-runtime'
      })
    )
    expect(runtimeEnvironmentCall.mock.calls.map(([args]) => args.method)).toEqual([
      'files.stat',
      'files.commitUpload',
      'files.delete'
    ])
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'files.commitUpload',
        params: expect.objectContaining({ requireExistingParent: true })
      })
    )
  }
)

it('fails and cleans up without creating directories when the destination disappears during staging', async () => {
  fsUploadExternalFileToRuntime.mockRejectedValue(new Error('ENOENT: destination removed'))
  expect((await paste()).results).toMatchObject([
    { status: 'failed', reason: 'ENOENT: destination removed' }
  ])
  expect(runtimeEnvironmentCall.mock.calls.map(([args]) => args.method)).toEqual([
    'files.stat',
    'files.delete'
  ])
})

it('refuses older hosts before staging or sending bytes', async () => {
  capabilities = [FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY]
  await expect(paste()).rejects.toThrow('newer Orca server')
  expect(fsStageExternalPathsForRuntimeUpload).not.toHaveBeenCalled()
  expect(fsUploadExternalFileToRuntime).not.toHaveBeenCalled()
  expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
})

it('preserves the existing import policy for callers on older hosts', async () => {
  capabilities = [FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY]
  await importExternalPathsToRuntime(context, ['/staging/pasted-image.png'], '/remote/notes/images')
  expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
    expect.objectContaining({ method: 'files.createDir' })
  )
  expect(fsUploadExternalFileToRuntime).toHaveBeenCalledWith(
    expect.not.objectContaining({ requireExistingParent: true })
  )
})

it('uses the existing local no-mkdir policy even when ensureDestinationDir was requested', async () => {
  fsImportExternalPaths.mockResolvedValue({ results: [] })
  await importExternalPathsToRuntime(
    { ...context, target: { kind: 'local' } },
    ['/staging/pasted-image.png'],
    '/remote/notes/images',
    { requireExistingDestination: true, ensureDestinationDir: true }
  )
  expect(fsImportExternalPaths).toHaveBeenCalledWith(expect.objectContaining({ ensureDir: false }))
  expect(fsStageExternalPathsForRuntimeUpload).not.toHaveBeenCalled()
})
