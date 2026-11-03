import { expect, it } from 'vitest'
import { createTerminalPathExistenceBatch } from '../components/terminal-pane/terminal-path-existence-batch'
import './runtime-file-metadata-client'
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

it('keeps two queued hovers on distinct revisions of the same environment', async () => {
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
  runtimeEnvironmentCall.mockResolvedValue({ id: 'result', ok: true, result: [{ exists: true }] })
  const context = {
    target: { kind: 'environment' as const, environmentId: 'owner' },
    worktreeId: 'folder-1',
    worktreePath: '/folder'
  }
  const enqueue = createTerminalPathExistenceBatch()
  replaceRuntimeEnvironmentRevisions([{ id: 'owner', createdAt: 10, pairingRevision: 10 }])
  const first = enqueue(context, '/folder/file.ts', true)
  replaceRuntimeEnvironmentRevisions([{ id: 'owner', createdAt: 10, pairingRevision: 20 }])
  const second = enqueue(context, '/folder/file.ts', true)
  expect(first).not.toBe(second)
  await Promise.all([first, second])
  expect(
    runtimeEnvironmentCall.mock.calls
      .map(([args]) => args.expectedEnvironmentPairingRevision)
      .sort()
  ).toEqual([10, 20])
})
