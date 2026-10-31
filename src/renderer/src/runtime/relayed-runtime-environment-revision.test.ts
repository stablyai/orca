import { beforeEach, expect, it, vi } from 'vitest'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'
import { toRelayedRuntimeEnvironmentId } from '../../../shared/relayed-runtime-environment'
import { callRuntimeRpc, clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import { stubRuntimeEnvironmentBridge } from './runtime-environment-bridge-fixture'

const call = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  call.mockReset()
  stubRuntimeEnvironmentBridge({ call })
  call.mockImplementation(({ method }: { method: string }) =>
    Promise.resolve({
      id: method,
      ok: true,
      result:
        method === 'status.get'
          ? {
              runtimeId: 'runtime-b',
              graphStatus: 'ready',
              runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
              minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
            }
          : [],
      _meta: { runtimeId: 'runtime-b' }
    })
  )
})

it("pins a relayed server's calls to the relaying server's pairing", async () => {
  replaceRuntimeEnvironmentRevisions([{ id: 'env-a', createdAt: 1, pairingRevision: 7 }])
  const environmentId = toRelayedRuntimeEnvironmentId({
    ownerEnvironmentId: 'env-a',
    ownerPairingRevision: 7,
    executionHost: 'runtime:vm-1'
  })

  await callRuntimeRpc({ kind: 'environment', environmentId }, 'files.readDir', {
    worktree: 'id:repo::/w',
    relativePath: ''
  })

  expect(call).toHaveBeenLastCalledWith(
    expect.objectContaining({
      selector: environmentId,
      method: 'files.readDir',
      expectedEnvironmentPairingRevision: 7
    })
  )
})
