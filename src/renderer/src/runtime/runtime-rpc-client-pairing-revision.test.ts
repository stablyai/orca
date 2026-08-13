import { beforeEach, expect, it, vi } from 'vitest'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'
import {
  callRuntimeRpc,
  clearRuntimeCompatibilityCacheForTests,
  probeLiveRuntimeEnvironmentCapabilities
} from './runtime-rpc-client'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'

const runtimeEnvironmentCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  replaceRuntimeEnvironmentRevisions([])
  runtimeEnvironmentCall.mockReset()
  vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeEnvironmentCall } } })
})

it('captures the pairing revision before awaiting the compatibility probe', async () => {
  let resolveStatus!: (response: unknown) => void
  replaceRuntimeEnvironmentRevisions([{ id: 'env-cas', createdAt: 1, pairingRevision: 10 }])
  runtimeEnvironmentCall.mockImplementation(({ method }: { method: string }) => {
    if (method === 'status.get') {
      return new Promise((resolve) => {
        resolveStatus = resolve
      })
    }
    return Promise.resolve({
      id: method,
      ok: true,
      result: { ok: true },
      _meta: { runtimeId: 'remote-runtime' }
    })
  })

  const request = callRuntimeRpc({ kind: 'environment', environmentId: 'env-cas' }, 'repo.list')
  await vi.waitFor(() => expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1))
  replaceRuntimeEnvironmentRevisions([{ id: 'env-cas', createdAt: 1, pairingRevision: 11 }])
  resolveStatus({
    id: 'status',
    ok: true,
    result: {
      runtimeId: 'remote-runtime',
      graphStatus: 'ready',
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
    },
    _meta: { runtimeId: 'remote-runtime' }
  })

  await expect(request).resolves.toEqual({ ok: true })
  expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(1, {
    selector: 'env-cas',
    method: 'status.get',
    timeoutMs: undefined,
    expectedEnvironmentPairingRevision: 10
  })
  expect(runtimeEnvironmentCall).toHaveBeenLastCalledWith({
    selector: 'env-cas',
    method: 'repo.list',
    params: undefined,
    timeoutMs: undefined,
    expectedEnvironmentPairingRevision: 10
  })
})

it('live capability probes ignore a warm cache and pin the captured pairing revision', async () => {
  replaceRuntimeEnvironmentRevisions([{ id: 'env-live', createdAt: 1, pairingRevision: 20 }])
  runtimeEnvironmentCall
    .mockResolvedValueOnce({
      id: 'warm-status',
      ok: true,
      result: {
        runtimeId: 'runtime-a',
        graphStatus: 'ready',
        runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
        minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
        capabilities: ['terminal.attribution-removed.v1']
      }
    })
    .mockResolvedValueOnce({ id: 'repo', ok: true, result: { repos: [] } })
    .mockImplementationOnce(async () => {
      replaceRuntimeEnvironmentRevisions([{ id: 'env-live', createdAt: 1, pairingRevision: 21 }])
      return {
        id: 'live-status',
        ok: true,
        result: {
          runtimeId: 'runtime-b',
          graphStatus: 'ready',
          runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
          minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
          capabilities: []
        }
      }
    })

  await callRuntimeRpc({ kind: 'environment', environmentId: 'env-live' }, 'repo.list')
  await expect(
    probeLiveRuntimeEnvironmentCapabilities({
      environmentId: 'env-live',
      requiredCapabilities: ['terminal.attribution-removed.v1']
    })
  ).resolves.toEqual({
    supported: false,
    authority: {
      runtimeId: 'runtime-b',
      expectedEnvironmentPairingRevision: 20,
      capabilities: []
    }
  })

  expect(runtimeEnvironmentCall).toHaveBeenLastCalledWith({
    selector: 'env-live',
    method: 'status.get',
    params: undefined,
    timeoutMs: undefined,
    expectedEnvironmentPairingRevision: 20
  })
})
