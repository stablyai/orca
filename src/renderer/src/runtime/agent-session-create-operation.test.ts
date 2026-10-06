import { describe, expect, it, vi } from 'vitest'
import { createAgentSessionCreateOperation } from './agent-session-create-operation'
import { RuntimeRpcCallError } from './runtime-rpc-result'

function rpcFailure(code: string): RuntimeRpcCallError {
  return new RuntimeRpcCallError({ id: 'request', ok: false, error: { code, message: code } })
}

describe('createAgentSessionCreateOperation', () => {
  it.each(['runtime_timeout', 'remote_runtime_unavailable'])(
    'replays under the same operation id when the desktop bridge reports %s',
    async (code) => {
      const invoke = vi
        .fn()
        .mockRejectedValueOnce(rpcFailure(code))
        .mockResolvedValueOnce('created')

      await expect(createAgentSessionCreateOperation().run(invoke)).resolves.toBe('created')
      expect(invoke).toHaveBeenCalledTimes(2)
      expect(invoke.mock.calls[1][0]).toBe(invoke.mock.calls[0][0])
    }
  )

  it('does not replay an answer the host gave', async () => {
    const invoke = vi.fn().mockRejectedValue(rpcFailure('agent_session_operation_conflict'))

    await expect(createAgentSessionCreateOperation().run(invoke)).rejects.toMatchObject({
      code: 'agent_session_operation_conflict'
    })
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('still replays a thrown transport error', async () => {
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce('created')

    await expect(createAgentSessionCreateOperation().run(invoke)).resolves.toBe('created')
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('replays once more after a reconnect when the immediate replay met a still-down network', async () => {
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(rpcFailure('remote_runtime_unavailable'))
      .mockRejectedValueOnce(rpcFailure('remote_runtime_unavailable'))
      .mockResolvedValueOnce('replayed')
    const waitToReplay = vi.fn(async () => true)

    await expect(createAgentSessionCreateOperation().run(invoke, { waitToReplay })).resolves.toBe(
      'replayed'
    )
    expect(waitToReplay).toHaveBeenCalledTimes(1)
    expect(new Set(invoke.mock.calls.map(([id]) => id)).size).toBe(1)
  })

  it('stays unknown when no reconnect comes', async () => {
    const invoke = vi.fn().mockRejectedValue(rpcFailure('remote_runtime_unavailable'))

    await expect(
      createAgentSessionCreateOperation().run(invoke, { waitToReplay: async () => false })
    ).rejects.toMatchObject({ code: 'remote_runtime_unavailable' })
    expect(invoke).toHaveBeenCalledTimes(2)
  })
})
