import { expect, it } from 'vitest'
import { createTerminalPathExistenceBatch } from '../components/terminal-pane/terminal-path-existence-batch'
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

for (const mode of ['scalar', 'queue', 'legacy', 'missing-method'] as const) {
  it(`${mode} retains the pairing owner when a hover waits for its queued flush`, async () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'owner', createdAt: 10, pairingRevision: 10 }])
    runtimeEnvironmentTransportCall.mockImplementation(async (args) => {
      if (args.method === 'status.get') {
        return {
          id: 'status',
          ok: true,
          result: {
            runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
            capabilities: mode === 'legacy' ? [] : ['files.pathsExist']
          },
          _meta: { runtimeId: 'owner-runtime' }
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

    const pending =
      mode === 'scalar'
        ? runtimePathExists(context, '/folder/file.ts')
        : createTerminalPathExistenceBatch()(context, '/folder/file.ts', true)

    replaceRuntimeEnvironmentRevisions([{ id: 'owner', createdAt: 10, pairingRevision: 20 }])
    await pending
    expect(runtimeEnvironmentCall.mock.calls.length).toBeGreaterThan(0)

    for (const [request] of runtimeEnvironmentCall.mock.calls) {
      expect(request.expectedEnvironmentPairingRevision).toBe(10)
    }
  })
}

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
    settings: { activeRuntimeEnvironmentId: 'owner' },
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
