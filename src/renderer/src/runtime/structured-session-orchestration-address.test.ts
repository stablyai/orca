import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRuntimeRpc = vi.hoisted(() => vi.fn())
vi.mock('./runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  callRuntimeRpc
}))

import { RuntimeRpcCallError } from './runtime-rpc-result'
import { resolveStructuredSessionOrchestrationAddress } from './structured-session-orchestration-address'

const LIVE = '7e3b9d15-2c4a-4f86-a0b1-5c9e2d7f3b64'
const ROOT = '4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37'
const LOCAL = { kind: 'local' } as const

function failure(code: string, message: string): RuntimeRpcCallError {
  return new RuntimeRpcCallError({
    id: 'rpc_1',
    ok: false,
    error: { code, message },
    _meta: { runtimeId: 'runtime_1' }
  })
}

describe('the orchestration address a chat copies', () => {
  beforeEach(() => {
    callRuntimeRpc.mockReset()
  })

  it("is the host's address for the conversation, not the live session id", async () => {
    callRuntimeRpc.mockResolvedValue({ address: `session:${ROOT}` })

    await expect(resolveStructuredSessionOrchestrationAddress(LOCAL, LIVE)).resolves.toBe(
      `session:${ROOT}`
    )
    expect(callRuntimeRpc).toHaveBeenCalledWith(LOCAL, 'orchestration.sessionAddress', {
      sessionId: LIVE
    })
  })

  it('is the live id on a host that predates the method, where it is the address', async () => {
    callRuntimeRpc.mockRejectedValue(failure('method_not_found', 'Unknown method'))

    await expect(resolveStructuredSessionOrchestrationAddress(LOCAL, LIVE)).resolves.toBe(
      `session:${LIVE}`
    )
  })

  it('surfaces any other failure instead of guessing', async () => {
    callRuntimeRpc.mockRejectedValue(failure('runtime_unavailable', 'down'))

    await expect(resolveStructuredSessionOrchestrationAddress(LOCAL, LIVE)).rejects.toThrow('down')
  })

  it('asks nothing for an id that is not an Orca session id', async () => {
    await expect(resolveStructuredSessionOrchestrationAddress(LOCAL, 'not an id')).resolves.toBe(
      null
    )
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })
})
