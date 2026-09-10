import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MAESTRO_WORKSPACE_CANVAS_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import {
  getRuntimeMaestroWorkspaceCanvas,
  mutateRuntimeMaestroWorkspaceCanvas
} from './runtime-maestro-workspace-client'

const scope = { execution_host_id: 'local', workspace_key: 'folder:folder-1' }
const runtimeCall = vi.fn()
const getStatus = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', { api: { runtime: { call: runtimeCall, getStatus } } })
})

describe('runtime Maestro workspace Canvas client', () => {
  it('returns update-required without calling an unknown method on an old peer', async () => {
    getStatus.mockResolvedValue({ capabilities: [] })
    await expect(getRuntimeMaestroWorkspaceCanvas({ kind: 'local' }, scope)).resolves.toEqual({
      status: 'unavailable',
      reason: 'update-required',
      liveness: 'unverifiable'
    })
    expect(runtimeCall).not.toHaveBeenCalled()
  })

  it('routes a negotiated query through the additive RPC method', async () => {
    getStatus.mockResolvedValue({ capabilities: [MAESTRO_WORKSPACE_CANVAS_RUNTIME_CAPABILITY] })
    runtimeCall.mockResolvedValue({
      id: 'request-1',
      ok: true,
      result: { status: 'unavailable', reason: 'scope-unavailable', liveness: 'unverifiable' },
      _meta: { runtimeId: 'runtime-1' }
    })
    await expect(getRuntimeMaestroWorkspaceCanvas({ kind: 'local' }, scope)).resolves.toMatchObject(
      {
        reason: 'scope-unavailable'
      }
    )
    expect(runtimeCall).toHaveBeenCalledWith({
      method: 'maestro.workspaceCanvas.get',
      params: scope
    })
  })

  it('reports a disconnected mutation as outcome unknown, never exited', async () => {
    getStatus.mockResolvedValue({ capabilities: [MAESTRO_WORKSPACE_CANVAS_RUNTIME_CAPABILITY] })
    runtimeCall.mockRejectedValue(new Error('connection_lost'))
    await expect(
      mutateRuntimeMaestroWorkspaceCanvas(
        { kind: 'local' },
        {
          action: 'create',
          scope,
          actor_id: 'actor-1',
          expected_authority_revision: 4,
          idempotency_key: 'create-1',
          surface_type: 'terminal'
        }
      )
    ).resolves.toMatchObject({
      status: 'outcome_unknown',
      authority_revision: 4,
      liveness: 'unverifiable'
    })
  })
})
