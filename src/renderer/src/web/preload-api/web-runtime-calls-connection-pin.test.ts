import { beforeEach, describe, expect, it, vi } from 'vitest'

const session = vi.hoisted(() => {
  const client = {
    connectionEpoch: 1,
    runtimeId: 'runtime-a',
    call: vi.fn()
  }
  return { client, environment: { id: 'env-1', createdAt: 1 } }
})

vi.mock('./web-runtime-session', async () => {
  const { RuntimeRpcCallQueuePool } = await import('../../../../shared/runtime-rpc-call-queue')
  return {
    getClientForEnvironment: () => session.client,
    manuallyDisconnectedEnvironmentIds: new Set<string>(),
    manuallyDisconnectedResponse: () => ({ ok: false }),
    requireActiveEnvironment: () => session.environment,
    resolveEnvironment: () => session.environment,
    runtimeCallQueuePool: new RuntimeRpcCallQueuePool(),
    updateEnvironmentFromResponse: () => undefined
  }
})

import {
  callRuntimeEnvelope,
  callEnvironmentEnvelope,
  callRuntimeResult
} from './web-runtime-calls'
import {
  RuntimeConnectionChangedBeforeSendError,
  RuntimeRpcCallError
} from '../../runtime/rpc/calls/runtime-rpc-result'

describe('web runtime call pinned to the probed runtime', () => {
  beforeEach(() => {
    session.client.connectionEpoch = 1
    session.client.runtimeId = 'runtime-a'
    session.client.call.mockReset()
    session.client.call.mockImplementation(async () => ({
      id: 'rpc',
      ok: true,
      result: {},
      _meta: { runtimeId: session.client.runtimeId }
    }))
  })

  it('refuses a runtime-pinned write after the client reconnected to another runtime', async () => {
    await callEnvironmentEnvelope('env-1', 'status.get')
    // The same client reconnects to an older server before the write is sent.
    session.client.connectionEpoch = 2
    session.client.runtimeId = 'runtime-b'

    await expect(
      callEnvironmentEnvelope('env-1', 'files.write', {}, 15_000, undefined, 'runtime-a')
    ).rejects.toBeInstanceOf(RuntimeConnectionChangedBeforeSendError)
    expect(session.client.call).not.toHaveBeenCalledWith(
      'files.write',
      expect.anything(),
      expect.anything()
    )
  })

  // Why: the status owner's reconnect probes bypass this wrapper, so cached callers would never recover.
  it('re-probes a reconnect to the same runtime and pins the write to the new connection', async () => {
    await callEnvironmentEnvelope('env-1', 'status.get')
    session.client.connectionEpoch = 2

    await callEnvironmentEnvelope('env-1', 'files.write', {}, 15_000, undefined, 'runtime-a')

    expect(session.client.call).toHaveBeenLastCalledWith(
      'files.write',
      {},
      { timeoutMs: 15_000, expectedConnectionEpoch: 2 }
    )
  })
})

it('preserves runtime failure details for web callers', async () => {
  session.client.call.mockResolvedValueOnce({
    id: 'rpc',
    ok: false,
    error: {
      code: 'runtime_error',
      message: 'Cannot add project',
      data: { reason: 'windows_drive' }
    }
  })

  const error = await callRuntimeResult('repo.add').catch((failure: unknown) => failure)
  expect(error).toBeInstanceOf(RuntimeRpcCallError)
  expect(error).toMatchObject({
    code: 'runtime_error',
    message: 'Cannot add project',
    response: { error: { data: { reason: 'windows_drive' } } }
  })
})

it('routes both web callers timed PR waits away from status and action calls', async () => {
  const release = Promise.withResolvers<void>()
  session.client.call.mockImplementation(async (_method, params) => {
    if (params?.reason === 'swr') {
      await release.promise
    }
    return { id: 'rpc', ok: true, result: 'current' }
  })
  const first = callRuntimeEnvelope('github.prForBranch', { reason: 'swr' })
  const second = callEnvironmentEnvelope('env-1', 'github.prForBranch', { reason: 'swr' })
  await expect(
    callEnvironmentEnvelope('env-1', 'github.prForBranch', { reason: 'manual' })
  ).resolves.toMatchObject({ result: 'current' })
  await expect(callRuntimeEnvelope('git.status')).resolves.toMatchObject({ result: 'current' })
  release.resolve()
  await Promise.all([first, second])
})
