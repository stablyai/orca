import { beforeEach, expect, it, vi } from 'vitest'
import {
  FOLDER_WORKSPACE_BACKEND_TEARDOWN_RUNTIME_CAPABILITY,
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import {
  clearRuntimeCompatibilityCacheForTests,
  runtimeEnvironmentSupportsCapability
} from './runtime-rpc-client'

const ENVIRONMENT_ID = 'env-capability-repair'
const runtimeEnvironmentCall = vi.fn()

function statusResponse(supported: boolean) {
  return {
    id: 'status.get',
    ok: true as const,
    result: {
      runtimeId: 'runtime-capability-repair',
      graphStatus: 'ready' as const,
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
      capabilities: supported ? [FOLDER_WORKSPACE_BACKEND_TEARDOWN_RUNTIME_CAPABILITY] : []
    },
    _meta: { runtimeId: 'runtime-capability-repair' }
  }
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  replaceRuntimeEnvironmentRevisions([])
  runtimeEnvironmentCall.mockReset()
  vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeEnvironmentCall } } })
})

it('does not reuse a capability verdict across a same-ID re-pair', async () => {
  replaceRuntimeEnvironmentRevisions([{ id: ENVIRONMENT_ID, createdAt: 1, pairingRevision: 41 }])
  runtimeEnvironmentCall
    .mockResolvedValueOnce(statusResponse(true))
    .mockResolvedValueOnce(statusResponse(false))

  await expect(
    runtimeEnvironmentSupportsCapability(
      ENVIRONMENT_ID,
      FOLDER_WORKSPACE_BACKEND_TEARDOWN_RUNTIME_CAPABILITY,
      15_000
    )
  ).resolves.toBe(true)

  replaceRuntimeEnvironmentRevisions([{ id: ENVIRONMENT_ID, createdAt: 1, pairingRevision: 42 }])

  await expect(
    runtimeEnvironmentSupportsCapability(
      ENVIRONMENT_ID,
      FOLDER_WORKSPACE_BACKEND_TEARDOWN_RUNTIME_CAPABILITY,
      15_000
    )
  ).resolves.toBe(false)
  expect(runtimeEnvironmentCall.mock.calls.map(([request]) => request)).toEqual([
    expect.objectContaining({
      method: 'status.get',
      expectedEnvironmentPairingRevision: 41
    }),
    expect.objectContaining({
      method: 'status.get',
      expectedEnvironmentPairingRevision: 42
    })
  ])
})
