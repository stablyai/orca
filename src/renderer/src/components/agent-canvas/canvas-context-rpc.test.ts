import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasContextSync } from '../../../../shared/canvas-agent-context'

const call = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: call,
  hasRuntimeRpcErrorCode: (error: { code?: string }, code: string) => error.code === code
}))
import { sendCanvasContextSnapshot } from './canvas-context-rpc'

const request: CanvasContextSync = {
  canvasId: 'folder-canvas',
  revision: 5,
  bindings: [],
  deferredBindings: []
}
const target = { kind: 'environment', environmentId: 'paired-host' } as const
beforeEach(() => {
  call.mockReset()
})

describe('canvas context cross-version RPC', () => {
  it('falls back on the same owning host only when the snapshot is complete', async () => {
    call
      .mockRejectedValueOnce({ code: 'method_not_found' })
      .mockResolvedValueOnce({ revision: 5, nodes: {} })
    await expect(sendCanvasContextSnapshot(target, request)).resolves.toEqual({
      revision: 5,
      nodes: {}
    })
    expect(call.mock.calls.map((args) => [args[0], args[1]])).toEqual([
      [target, 'agentHooks.canvasContextSync'],
      [target, 'agentHooks.canvasContext']
    ])
    expect(call.mock.calls[1][2]).not.toHaveProperty('deferredBindings')
  })
  it('never drops deferred identity fences through an old host fallback', async () => {
    call.mockRejectedValue({ code: 'method_not_found' })
    await expect(
      sendCanvasContextSnapshot(target, {
        ...request,
        deferredBindings: [
          { nodeId: 'unverifiable', notes: [], peers: [], collaborationPaused: true }
        ]
      })
    ).rejects.toMatchObject({ code: 'method_not_found' })
    expect(call).toHaveBeenCalledTimes(1)
  })
  it.each(['timeout', 'connection_closed', 'permission_denied'])(
    'does not retry %s through the legacy method',
    async (code) => {
      call.mockRejectedValue({ code })
      await expect(sendCanvasContextSnapshot(target, request)).rejects.toMatchObject({ code })
      expect(call).toHaveBeenCalledTimes(1)
    }
  )
})
