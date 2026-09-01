import { describe, expect, it, vi } from 'vitest'
import { createWorktreeAgentLaunchActions } from './worktree-agent-launch-actions'

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  getActiveRuntimeTarget: vi.fn((settings: { activeRuntimeEnvironmentId?: string | null }) =>
    settings.activeRuntimeEnvironmentId
      ? { kind: 'environment' as const, environmentId: settings.activeRuntimeEnvironmentId }
      : { kind: 'local' as const }
  )
}))

vi.mock('../../../runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.callRuntimeRpc,
  getActiveRuntimeTarget: mocks.getActiveRuntimeTarget
}))

vi.mock('@/lib/browser-uuid', () => ({
  createBrowserUuid: () => 'mutation-1'
}))

describe('background agent launch recovery host routing', () => {
  it('routes a same-id card action to its explicit runtime host', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ status: 'launched', receipt: {} })
    const get = () => ({
      settings: { activeRuntimeEnvironmentId: 'focused-host' },
      runtimeEnvironments: [],
      worktreesByRepo: {},
      detectedWorktreesByRepo: {}
    })
    const actions = createWorktreeAgentLaunchActions(vi.fn() as never, get as never)

    await actions.retryBackgroundAgentLaunch({
      attemptId: 'attempt-1',
      worktreeId: 'repo::/same/path',
      executionHostId: 'runtime:card-host',
      expectedFailureId: 'failure-1',
      action: { kind: 'retry-same' }
    })

    expect(mocks.callRuntimeRpc).toHaveBeenCalledExactlyOnceWith(
      { kind: 'environment', environmentId: 'card-host' },
      'worktree.retryBackgroundAgentLaunch',
      {
        attemptId: 'attempt-1',
        expectedFailureId: 'failure-1',
        clientMutationId: 'mutation-1',
        action: { kind: 'retry-same' }
      },
      { timeoutMs: 10 * 60_000 }
    )
  })
})
