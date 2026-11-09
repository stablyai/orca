import { expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../../rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.rpc }))
import { discoverRuntimeTerminalModels } from './terminal-model-discovery-client'

it('uses the explicit workspace read without client command overrides or a legacy fallback', async () => {
  const local = vi.fn()
  vi.stubGlobal('window', { api: { git: { discoverTerminalModels: local } } })
  const context = {
    target: { kind: 'environment', environmentId: 'windows' } as const,
    worktreeId: 'repo::C:\\work',
    worktreePath: 'C:\\work',
    prefs: { agentCmdOverrides: { antigravity: 'agy-client' } }
  }
  mocks.rpc.mockRejectedValueOnce(
    Object.assign(new Error('method_not_found'), { code: 'method_not_found' })
  )
  await expect(discoverRuntimeTerminalModels(context, 'antigravity')).rejects.toThrow(
    'method_not_found'
  )
  expect(mocks.rpc).toHaveBeenCalledWith(
    context.target,
    'agent.discoverTerminalModels',
    {
      worktree: 'id:repo::C:\\work',
      agentId: 'antigravity'
    },
    { timeoutMs: 75000 }
  )
  mocks.rpc.mockClear()
  expect(
    await discoverRuntimeTerminalModels({ ...context, worktreeId: undefined }, 'antigravity')
  ).toMatchObject({ success: false })
  expect(mocks.rpc).not.toHaveBeenCalled()
  expect(local).not.toHaveBeenCalled()
  await discoverRuntimeTerminalModels({ ...context, target: { kind: 'local' } }, 'antigravity')
  expect(local).toHaveBeenCalledWith({ worktree: 'id:repo::C:\\work', agentId: 'antigravity' })
  vi.unstubAllGlobals()
})
