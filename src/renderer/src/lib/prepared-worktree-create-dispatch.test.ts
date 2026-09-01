import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeCreationRequest } from './pending-worktree-creation'

const createWorktree = vi.fn(async () => ({ created: true }) as never)

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ createWorktree }) }
}))

const { dispatchPreparedWorktreeCreate } = await import('./prepared-worktree-create-dispatch')

function request(overrides: Partial<WorktreeCreationRequest> = {}): WorktreeCreationRequest {
  return {
    repoId: 'repo-1',
    name: 'feature',
    setupDecision: 'inherit',
    agent: null,
    pendingFirstAgentMessageRename: false,
    note: '',
    startupPlan: null,
    quickPrompt: '',
    quickTelemetry: null,
    ...overrides
  }
}

/** The store branches on `options.provisionedRoot` to call `adoptProvisionedRoot`
 *  instead of `worktrees.create`, so the last positional arg is the whole feature. */
function lastCallOptions(): Record<string, unknown> {
  const args = createWorktree.mock.calls[0] as unknown[]
  return args.at(-1) as Record<string, unknown>
}

const PROVISIONED_ROOT = {
  ephemeralVmCheckoutMode: 'provisioned-root',
  ephemeralVmRuntimeId: 'runtime-1',
  ephemeralVmExpectedRefHead: 'abc123',
  workspaceRunContext: {
    kind: 'workspace-run',
    projectId: 'project-1',
    hostId: 'ssh:runtime-ssh-one',
    projectHostSetupId: 'setup-1',
    repoId: 'repo-runtime',
    path: '/workspace/repo'
  }
} satisfies Partial<WorktreeCreationRequest>

describe('dispatchPreparedWorktreeCreate', () => {
  beforeEach(() => {
    createWorktree.mockClear()
  })

  it('forwards the provisioned-root adoption identity', async () => {
    await dispatchPreparedWorktreeCreate('creation-1', request(PROVISIONED_ROOT))

    expect(lastCallOptions().provisionedRoot).toEqual({
      runtimeId: 'runtime-1',
      executionHostId: 'ssh:runtime-ssh-one',
      expectedPath: '/workspace/repo',
      expectedRefHead: 'abc123'
    })
  })

  it('omits provisionedRoot for an ordinary create', async () => {
    await dispatchPreparedWorktreeCreate('creation-1', request())

    expect('provisionedRoot' in lastCallOptions()).toBe(false)
  })

  it('propagates incomplete provisioned-root identity instead of creating', () => {
    expect(() =>
      dispatchPreparedWorktreeCreate(
        'creation-1',
        request({ ephemeralVmCheckoutMode: 'provisioned-root' })
      )
    ).toThrow('identity is incomplete')
    expect(createWorktree).not.toHaveBeenCalled()
  })

  it('passes the creation id and agent-launch telemetry through', async () => {
    await dispatchPreparedWorktreeCreate(
      'creation-1',
      request({
        agentLaunch: { selection: { kind: 'agent', agent: 'claude' } } as never,
        quickTelemetry: { launch_source: 'composer', request_kind: 'new' } as never
      })
    )

    expect(createWorktree.mock.calls[0]).toContain('creation-1')
    expect(lastCallOptions().agentLaunchTelemetry).toEqual({
      launch_source: 'composer',
      request_kind: 'new'
    })
  })
})
