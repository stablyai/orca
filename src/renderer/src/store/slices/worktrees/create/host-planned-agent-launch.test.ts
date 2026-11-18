import { beforeEach, expect, it, vi } from 'vitest'
import { createWorktreeOnRuntimeHost } from './host-planned-agent-launch'
import type { WorktreeCreateRequest } from './worktree-create-payload'

const mocks = vi.hoisted(() => ({ supports: vi.fn(), call: vi.fn() }))
vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: mocks.supports
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.call }))

beforeEach(() => {
  mocks.supports.mockReset()
  mocks.call.mockReset().mockResolvedValue({ worktree: { id: 'created' } })
})

const request: WorktreeCreateRequest = {
  repoId: 'repo',
  name: 'task',
  options: { creationAgentLaunch: { agent: 'claude', inputs: { omitEffort: true } } }
}

it.each(['agent.launch.omit-effort', 'worktree.create-agent-options.v1', 'unknown'])(
  'refuses Default before creating a worktree when the host lacks %s',
  async (missing) => {
    mocks.supports.mockImplementation(async (_host: string, capability: string) => {
      if (missing === 'unknown') {
        throw new Error('offline')
      }
      return capability !== missing
    })
    await expect(
      createWorktreeOnRuntimeHost('host', request, { name: 'task' }, {})
    ).rejects.toThrow('cannot launch with Default effort')
    expect(mocks.call).not.toHaveBeenCalled()
  }
)

it('carries Default to a capable creation host', async () => {
  mocks.supports.mockResolvedValue(true)
  await createWorktreeOnRuntimeHost('host', request, { name: 'task' }, {})
  expect(mocks.call.mock.calls[0]?.[2]).toMatchObject({
    repo: 'repo',
    name: 'task',
    startupAgent: 'claude',
    startupOmitEffort: true
  })
})
