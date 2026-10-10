import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  resolveAgentSessionLaunchRoute: vi.fn(),
  getState: vi.fn(() => ({}))
}))

vi.mock('@/lib/agent-session-launch-plan', () => ({
  resolveAgentSessionLaunchRoute: mocks.resolveAgentSessionLaunchRoute
}))
vi.mock('@/store', () => ({ useAppStore: { getState: mocks.getState } }))

import { sourceControlLaunchAppliesAgentArgs } from './source-control-launch-agent-args-applicability'

describe('sourceControlLaunchAppliesAgentArgs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveAgentSessionLaunchRoute.mockReturnValue('terminal-tui')
  })

  it('applies arguments when the user launches into a terminal by default', () => {
    expect(
      sourceControlLaunchAppliesAgentArgs({
        agent: 'codex',
        worktreeId: 'wt-1'
      })
    ).toBe(true)
  })

  it('drops arguments only when this launch would really be a structured session', () => {
    mocks.resolveAgentSessionLaunchRoute.mockReturnValue('structured-native-chat')
    expect(
      sourceControlLaunchAppliesAgentArgs({
        agent: 'codex',
        worktreeId: 'wt-1'
      })
    ).toBe(false)
  })

  it('keeps arguments for a chat-by-default user whose launch falls back to a terminal', () => {
    // A remote host, an agent without a structured session, or a floating workspace all land here.
    mocks.resolveAgentSessionLaunchRoute.mockReturnValue('terminal-tui')
    expect(
      sourceControlLaunchAppliesAgentArgs({
        agent: 'codex',
        worktreeId: 'wt-1'
      })
    ).toBe(true)
  })

  it('applies arguments while no agent is chosen yet', () => {
    expect(
      sourceControlLaunchAppliesAgentArgs({
        agent: null,
        worktreeId: 'wt-1'
      })
    ).toBe(true)
    expect(mocks.resolveAgentSessionLaunchRoute).not.toHaveBeenCalled()
  })

  it('names the repo and its host when the workspace does not exist yet', () => {
    sourceControlLaunchAppliesAgentArgs({
      agent: 'codex',
      repoId: 'repo-1',
      executionHostId: 'ssh:build-box'
    })
    expect(mocks.resolveAgentSessionLaunchRoute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspace: {
          kind: 'git-worktree',
          repoId: 'repo-1',
          executionHostId: 'ssh:build-box'
        }
      })
    )
  })
})
