import { describe, expect, it, vi } from 'vitest'
import { createAgentSessionOperationId } from './agent-session-operation-id'
import {
  createAgentSessionCreateOperation,
  toAgentLaunchPreferences
} from './agent-session-create-operation'
import { RuntimeRpcCallError } from './runtime-rpc-client'

describe('createAgentSessionOperationId', () => {
  it('combines the request time with a cryptographically generated nonce', () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.fill(0xab)
      return bytes
    })
    vi.stubGlobal('crypto', { getRandomValues })

    expect(createAgentSessionOperationId(1234)).toBe(`1234-${'ab'.repeat(16)}`)
    expect(getRandomValues).toHaveBeenCalledOnce()
    vi.unstubAllGlobals()
  })

  it('fails closed when secure randomness is unavailable', () => {
    vi.stubGlobal('crypto', undefined)
    expect(() => createAgentSessionOperationId(1234)).toThrow('Secure randomness is unavailable')
    vi.unstubAllGlobals()
  })
})

describe('agent session create operation', () => {
  it('retries an ambiguous transport failure with one stable operation ID', async () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(0xcd)
        return bytes
      }
    })
    const operation = createAgentSessionCreateOperation()
    const invoke = vi
      .fn<(operationId: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error('connection closed before response'))
      .mockResolvedValueOnce('created')

    await expect(operation.run(invoke)).resolves.toBe('created')
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(invoke.mock.calls[0]?.[0]).toBe(operation.clientOperationId)
    expect(invoke.mock.calls[1]?.[0]).toBe(operation.clientOperationId)
    vi.unstubAllGlobals()
  })

  it('does not retry an authoritative host failure', async () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => bytes
    })
    const operation = createAgentSessionCreateOperation()
    const failure = new RuntimeRpcCallError({
      id: 'rpc-1',
      ok: false,
      error: { code: 'agent_session_operation_capacity', message: 'capacity' }
    })
    const invoke = vi.fn().mockRejectedValue(failure)

    await expect(operation.run(invoke)).rejects.toBe(failure)
    expect(invoke).toHaveBeenCalledOnce()
    vi.unstubAllGlobals()
  })

  it('keeps only supported string launch preferences', () => {
    expect(
      toAgentLaunchPreferences({
        model: ' gpt-5 ',
        effort: 'high',
        mode: 'plan',
        fastMode: true
      })
    ).toEqual({ model: 'gpt-5', effort: 'high', mode: 'plan' })
  })
})
