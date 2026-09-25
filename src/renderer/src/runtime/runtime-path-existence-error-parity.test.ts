import { expect, it } from 'vitest'
import { runtimePathsExist } from './runtime-path-existence-batch'
import { runtimePathExists } from './runtime-file-metadata-client'
import {
  installRuntimeFileClientEnvironment,
  runtimeEnvironmentCall,
  runtimeEnvironmentTransportCall
} from './runtime-file-client-test-harness'
import {
  RUNTIME_PROTOCOL_VERSION,
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
} from '../../../shared/protocol-version'
installRuntimeFileClientEnvironment()
for (const mode of ['scalar', 'batch'] as const) {
  it(`${mode} preserves missing-owner error interpretation`, async () => {
    runtimeEnvironmentTransportCall.mockImplementation(async (args) =>
      args.method === 'status.get'
        ? {
            id: 'status',
            ok: true,
            result: {
              runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
              minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
              capabilities: ['files.pathsExist']
            },
            _meta: { runtimeId: 'owner-runtime' }
          }
        : runtimeEnvironmentCall(args)
    )
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'missing',
      ok: false,
      error: { code: 'not_found', message: 'Worktree not found: id:folder-1' }
    })
    const context = {
      settings: { activeRuntimeEnvironmentId: 'owner' },
      worktreeId: 'folder-1',
      worktreePath: '/folder'
    }
    if (mode === 'scalar') {
      expect(await runtimePathExists(context, '/folder/file.ts')).toBe(false)
    } else {
      expect(await runtimePathsExist(context, ['/folder/file.ts'])).toEqual([{ exists: false }])
    }
  })
}

for (const stage of ['status', 'operation'] as const) {
  it(`preserves missing errors from ${stage} and still rejects permission/transport failures`, async () => {
    let message = 'Worktree not found: id:folder-1'
    const failure = () => ({ id: 'failure', ok: false, error: { code: 'not_found', message } })
    runtimeEnvironmentTransportCall.mockImplementation(async (args) =>
      args.method === 'status.get'
        ? stage === 'status'
          ? failure()
          : {
              id: 'status',
              ok: true,
              result: {
                runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
                minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
                capabilities: ['files.pathsExist']
              },
              _meta: { runtimeId: 'owner-runtime' }
            }
        : runtimeEnvironmentCall(args)
    )
    runtimeEnvironmentCall.mockImplementation(async () => failure())
    const context = {
      settings: { activeRuntimeEnvironmentId: 'owner' },
      worktreeId: 'folder-1',
      worktreePath: '/folder'
    }
    expect(await runtimePathsExist(context, ['/folder/file.ts'])).toEqual([{ exists: false }])
    for (message of ['permission denied', 'SSH connection closed']) {
      await expect(runtimePathsExist(context, ['/folder/file.ts'])).rejects.toThrow(message)
    }
  })
}
