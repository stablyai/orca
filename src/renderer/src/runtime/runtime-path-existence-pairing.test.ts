import { expect, it } from 'vitest'
import { runtimePathsExist } from './runtime-path-existence-batch'
import { runtimePathExists } from './runtime-file-metadata-client'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
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

for (const mode of ['scalar', 'batch', 'legacy', 'missing-method']) {
  const batch = mode !== 'scalar'
  it(`${mode} preserves the owner captured before discovery`, async () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'owner', createdAt: 10, pairingRevision: 10 }])
    runtimeEnvironmentTransportCall.mockImplementation(async (args) => {
      if (args.method === 'status.get') {
        replaceRuntimeEnvironmentRevisions([{ id: 'owner', createdAt: 10, pairingRevision: 20 }])

        return {
          id: 'status',
          ok: true,
          result: {
            runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
            capabilities: mode === 'legacy' ? [] : ['files.pathsExist']
          },
          _meta: { runtimeId: 'original-owner' }
        }
      }

      return runtimeEnvironmentCall(args)
    })
    runtimeEnvironmentCall.mockImplementation(async (args) => {
      if (mode === 'missing-method' && args.method === 'files.pathsExist') {
        replaceRuntimeEnvironmentRevisions([{ id: 'owner', createdAt: 10, pairingRevision: 30 }])

        return {
          id: 'missing',
          ok: false,
          error: { code: 'method_not_found', message: 'Unknown method' }
        }
      }

      return { id: 'result', ok: true, result: [{ exists: true }] }
    })

    const context = {
      settings: { activeRuntimeEnvironmentId: 'owner' },
      worktreeId: 'folder-1',
      worktreePath: '/folder'
    }

    await (batch
      ? runtimePathsExist(context, ['/folder/file.ts'])
      : runtimePathExists(context, '/folder/file.ts'))
    expect(runtimeEnvironmentCall.mock.calls.length).toBeGreaterThan(0)

    for (const [request] of runtimeEnvironmentCall.mock.calls) {
      expect(request.expectedEnvironmentPairingRevision).toBe(10)
    }
  })
}
