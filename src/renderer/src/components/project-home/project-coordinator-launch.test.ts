import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  preflight: vi.fn(),
  capability: vi.fn(),
  focus: vi.fn(),
  owner: vi.fn(),
  getWorktree: vi.fn(),
  activate: vi.fn(),
  setView: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      settings: { disabledTuiAgents: [] },
      getKnownWorktreeById: mocks.getWorktree,
      setActiveWorktree: mocks.activate,
      setActiveView: mocks.setView
    })
  }
}))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: mocks.launch }))
vi.mock('@/lib/agent-session-launch-plan', () => ({
  adoptAgentSessionLaunchVerdict: (verdict: unknown) => verdict
}))
vi.mock('@/lib/agent-trust-preflight', () => ({ preflightAgentTrust: mocks.preflight }))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: mocks.focus }))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => 'local',
  getRuntimeEnvironmentIdForWorktree: mocks.owner
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdFromState: () => null }))
vi.mock('./project-home-api', () => ({ assertProjectHomeCapability: mocks.capability }))
import { coordinatorPrompt, launchProjectCoordinator } from './project-coordinator-launch'
const args = {
  target: { kind: 'local' },
  repoId: 'repo',
  executionHostId: 'local',
  worktreeId: 'workspace',
  agent: 'claude',
  prompt: 'Goal'
} as const
beforeEach(() => {
  vi.clearAllMocks()
  mocks.capability.mockResolvedValue({})
  mocks.preflight.mockResolvedValue(undefined)
  mocks.owner.mockReturnValue(null)
  mocks.getWorktree.mockReturnValue({ id: 'workspace', repoId: 'repo', path: '/repo' })
  mocks.launch.mockReturnValue({ surface: { kind: 'local-terminal', tabId: 'tab' } })
})
describe('project coordinator launch', () => {
  it('never launches when the host cannot prove context capability', async () => {
    mocks.capability.mockRejectedValue(new Error('Update Orca'))
    await expect(launchProjectCoordinator(args)).rejects.toThrow('Update Orca')
    expect(mocks.preflight).not.toHaveBeenCalled()
    expect(mocks.launch).not.toHaveBeenCalled()
  })

  it('preflights and opens a terminal route with an unsubmitted draft', async () => {
    await launchProjectCoordinator(args)
    expect(mocks.preflight).toHaveBeenCalledWith({
      agent: 'claude',
      workspacePath: '/repo',
      connectionId: null
    })
    expect(mocks.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        promptDelivery: 'draft',
        agentSessionLaunchPlan: expect.objectContaining({
          route: 'terminal-tui',
          promptDelivery: 'draft'
        })
      })
    )
    expect(mocks.preflight.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.launch.mock.invocationCallOrder[0]!
    )
    expect(mocks.focus).toHaveBeenCalledWith('tab')
  })
  it('does not launch against a different runtime or a changed workspace', async () => {
    mocks.owner.mockReturnValue('remote')
    await expect(launchProjectCoordinator(args)).rejects.toThrow('ownership')
    expect(mocks.launch).not.toHaveBeenCalled()
    mocks.owner.mockReturnValueOnce(null).mockReturnValue('remote')
    await expect(launchProjectCoordinator(args)).rejects.toThrow('changed')
    expect(mocks.launch).not.toHaveBeenCalled()
  })
  it('does not retry a failed launch or focus a made-up paired tab', async () => {
    mocks.launch.mockReturnValue(null)
    await expect(launchProjectCoordinator(args)).rejects.toThrow('prepare')
    expect(mocks.launch).toHaveBeenCalledTimes(1)
    expect(mocks.focus).not.toHaveBeenCalled()
    mocks.launch.mockReturnValue({ surface: { kind: 'host-published' } })
    await launchProjectCoordinator(args)
    expect(mocks.focus).not.toHaveBeenCalled()
  })
  it('includes saved context as plain prompt text', () => {
    expect(coordinatorPrompt('Goal $(literal)', 'Instructions `literal`')).toContain(
      'Goal $(literal)'
    )
    expect(coordinatorPrompt('Goal', 'Instructions `literal`')).toContain('Instructions `literal`')
  })
})
