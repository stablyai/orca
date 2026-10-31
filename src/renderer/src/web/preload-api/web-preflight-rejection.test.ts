import { expect, it, vi } from 'vitest'
const rpc = vi.hoisted(() => vi.fn())
vi.mock('./web-runtime-calls', () => ({ callRuntimeResult: rpc }))
vi.mock('./web-runtime-session', () => ({ requireActiveEnvironmentOrNull: () => ({ id: 'peer' }) }))
import { createPreflightApi } from './web-host-capability-api'

it('retains the web compatibility fallback on rejection and accepts the next real host result', async () => {
  const api = createPreflightApi()
  rpc.mockRejectedValue(new Error('host probe unavailable'))
  await expect(api.detectAgents()).resolves.toEqual([])
  await expect(api.refreshAgents()).resolves.toMatchObject({
    agents: [],
    shellHydrationOk: false,
    pathFailureReason: 'spawn_error'
  })
  await expect(api.detectRemoteAgents({ connectionId: 'host-owned-ssh' })).resolves.toEqual([])
  expect(rpc.mock.calls).toEqual([
    ['preflight.detectAgents'],
    ['preflight.refreshAgents'],
    ['preflight.detectRemoteAgents', { connectionId: 'host-owned-ssh' }]
  ])
  rpc.mockResolvedValueOnce(['codex'])
  await expect(api.detectAgents()).resolves.toEqual(['codex'])
})
