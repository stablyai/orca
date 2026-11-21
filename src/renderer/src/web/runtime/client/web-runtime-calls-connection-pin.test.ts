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
  const { RuntimeRpcCallQueuePool } =
    await import('../../../../../shared/remote-runtime/rpc/runtime-rpc-call-queue')
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

import { callEnvironmentEnvelope } from './web-runtime-calls'
import { RuntimeConnectionChangedBeforeSendError } from '../../../runtime/rpc/calls/runtime-rpc-result'

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
})
