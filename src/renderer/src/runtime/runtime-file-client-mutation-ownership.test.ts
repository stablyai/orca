import { describe, expect, it } from 'vitest'
import {
  copyRuntimePath,
  createRuntimePath,
  deleteRuntimePath,
  renameRuntimePath,
  writeRuntimeFile
} from './runtime-file-mutation-client'
import { importExternalPathsToRuntime } from './runtime-file-import-client'
import { markRuntimeEnvironmentCompatible } from './runtime-rpc-client'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import {
  FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY,
  FILE_MUTATION_OWNERSHIP_UPDATE_REQUIRED_MESSAGE,
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'
import {
  fsCopy,
  fsCreateFile,
  fsRename,
  fsDeletePath,
  fsImportExternalPaths,
  fsStageExternalPathsForRuntimeUpload,
  runtimeEnvironmentCall,
  runtimeEnvironmentTransportCall,
  installRuntimeFileClientEnvironment
} from './runtime-file-client-test-harness'

installRuntimeFileClientEnvironment()

describe('runtime file client', () => {
  it('refuses old-HUB imports before staging client-local files', async () => {
    runtimeEnvironmentTransportCall.mockImplementation((args: { method: string }) => {
      if (args.method === 'status.get') {
        return Promise.resolve({
          id: 'status',
          ok: true,
          result: {
            runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
            capabilities: []
          },
          _meta: { runtimeId: 'old-hub-runtime' }
        })
      }
      return runtimeEnvironmentCall(args)
    })

    await expect(
      importExternalPathsToRuntime(
        {
          target: { kind: 'environment' as const, environmentId: 'env-old-hub' },
          worktreeId: 'wt-nested-ssh',
          worktreePath: '/ssh/repo',
          expectedExecutionHostId: 'ssh:hub-ssh-1',
          expectedSshTargetId: 'hub-ssh-1',
          expectedSshConnectionGeneration: 7
        },
        ['/client/secret.txt'],
        '/ssh/repo/uploads'
      )
    ).rejects.toThrow(FILE_MUTATION_OWNERSHIP_UPDATE_REQUIRED_MESSAGE)

    expect(fsStageExternalPathsForRuntimeUpload).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(fsImportExternalPaths).not.toHaveBeenCalled()
  })

  it('re-probes mutation support so a HUB downgrade cannot reuse a cached capability', async () => {
    let statusCalls = 0
    runtimeEnvironmentTransportCall.mockImplementation((args: { method: string }) => {
      if (args.method === 'status.get') {
        statusCalls += 1
        return Promise.resolve({
          id: 'status',
          ok: true,
          result: {
            runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
            capabilities: statusCalls === 1 ? [FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY] : []
          },
          _meta: { runtimeId: statusCalls === 1 ? 'new-hub-runtime' : 'old-hub-runtime' }
        })
      }
      return runtimeEnvironmentCall(args)
    })
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'write',
      ok: true,
      result: { ok: true },
      _meta: { runtimeId: 'new-hub-runtime' }
    })
    const context = {
      target: { kind: 'environment' as const, environmentId: 'env-downgraded' },
      worktreeId: 'wt-hub-local',
      worktreePath: '/hub/repo',
      expectedExecutionHostId: 'local' as const
    }

    await writeRuntimeFile(context, '/hub/repo/readme.md', 'first')
    await expect(deleteRuntimePath(context, '/hub/repo/readme.md')).rejects.toThrow(
      FILE_MUTATION_OWNERSHIP_UPDATE_REQUIRED_MESSAGE
    )

    expect(statusCalls).toBe(3)
    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1)
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.delete' })
    )
    expect(fsDeletePath).not.toHaveBeenCalled()
  })

  it('fails closed when a same-id re-pair occurs after the capability probe', async () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'env-repaired', createdAt: 1, pairingRevision: 41 }])
    markRuntimeEnvironmentCompatible('env-repaired')
    let currentRevision = 41
    runtimeEnvironmentTransportCall.mockImplementation(
      (args: { method: string; expectedEnvironmentPairingRevision?: number }) => {
        if (args.expectedEnvironmentPairingRevision !== currentRevision) {
          return Promise.resolve({
            id: args.method,
            ok: false,
            error: {
              code: 'runtime_environment_repaired',
              message: 'Runtime environment was re-paired before the mutation.'
            },
            _meta: { runtimeId: 'old-hub-runtime' }
          })
        }
        if (args.method === 'status.get') {
          currentRevision = 42
          replaceRuntimeEnvironmentRevisions([
            { id: 'env-repaired', createdAt: 1, pairingRevision: currentRevision }
          ])
          return Promise.resolve({
            id: 'status',
            ok: true,
            result: {
              runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
              minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
              capabilities: [FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY]
            },
            _meta: { runtimeId: 'new-hub-runtime' }
          })
        }
        return runtimeEnvironmentCall(args)
      }
    )

    await expect(
      deleteRuntimePath(
        {
          target: { kind: 'environment' as const, environmentId: 'env-repaired' },
          worktreeId: 'wt-nested-ssh',
          worktreePath: '/ssh/repo',
          expectedExecutionHostId: 'ssh:hub-ssh-1',
          expectedSshTargetId: 'hub-ssh-1',
          expectedSshConnectionGeneration: 7
        },
        '/ssh/repo/readme.md'
      )
    ).rejects.toThrow('re-paired before the mutation')

    expect(runtimeEnvironmentTransportCall).toHaveBeenNthCalledWith(1, {
      selector: 'env-repaired',
      method: 'status.get',
      params: undefined,
      timeoutMs: 15_000,
      expectedEnvironmentPairingRevision: 41
    })
    expect(runtimeEnvironmentTransportCall).toHaveBeenNthCalledWith(2, {
      selector: 'env-repaired',
      method: 'files.delete',
      params: {
        worktree: 'id:wt-nested-ssh',
        relativePath: 'readme.md',
        recursive: undefined,
        expectedExecutionHostId: 'ssh:hub-ssh-1',
        expectedSshTargetId: 'hub-ssh-1',
        expectedSshConnectionGeneration: 7
      },
      timeoutMs: 15_000,
      expectedEnvironmentPairingRevision: 41
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(fsDeletePath).not.toHaveBeenCalled()
  })

  it('does not fall back to client-local mutations for remote-owned paths outside the worktree', async () => {
    const context = {
      target: { kind: 'environment' as const, environmentId: 'env-1' },
      worktreeId: 'wt-1',
      worktreePath: '/remote/repo'
    }

    await expect(createRuntimePath(context, '/tmp/new.ts', 'file')).rejects.toThrow(
      'outside the owning runtime worktree'
    )
    await expect(
      renameRuntimePath(context, '/remote/repo/src/new.ts', '/tmp/renamed.ts')
    ).rejects.toThrow('outside the owning runtime worktree')
    await expect(
      copyRuntimePath(context, '/remote/repo/src/new.ts', '/tmp/copied.ts')
    ).rejects.toThrow('outside the owning runtime worktree')
    await expect(deleteRuntimePath(context, '/tmp/new.ts')).rejects.toThrow(
      'outside the owning runtime worktree'
    )

    expect(fsCreateFile).not.toHaveBeenCalled()
    expect(fsRename).not.toHaveBeenCalled()
    expect(fsCopy).not.toHaveBeenCalled()
    expect(fsDeletePath).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('does not fall back to client-local mutations when a remote Windows path escapes the worktree', async () => {
    const context = {
      target: { kind: 'environment' as const, environmentId: 'env-1' },
      worktreeId: 'wt-1',
      worktreePath: 'C:\\repo'
    }

    await expect(createRuntimePath(context, 'D:\\repo\\new.ts', 'file')).rejects.toThrow(
      'outside the owning runtime worktree'
    )
    await expect(
      createRuntimePath(context, '\\\\server\\share\\repo\\new.ts', 'file')
    ).rejects.toThrow('outside the owning runtime worktree')

    expect(fsCreateFile).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })
})
