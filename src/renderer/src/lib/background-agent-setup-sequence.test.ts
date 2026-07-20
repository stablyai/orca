import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockLaunchWorktreeBackgroundTerminals = vi.fn()

vi.mock('@/lib/launch-worktree-background-terminals', () => ({
  launchWorktreeBackgroundTerminals: mockLaunchWorktreeBackgroundTerminals
}))

describe('sequenceBackgroundAgentStartupAfterSetup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLaunchWorktreeBackgroundTerminals.mockResolvedValue(undefined)
  })

  it('pairs setup and agent commands with one completion marker before returning', async () => {
    const { sequenceBackgroundAgentStartupAfterSetup } =
      await import('./background-agent-setup-sequence')

    const result = await sequenceBackgroundAgentStartupAfterSetup(
      'wt-1',
      {
        agent: 'claude',
        launchCommand: "claude 'run the automation'",
        expectedProcess: 'claude',
        followupPrompt: null,
        launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
        env: { EXISTING: 'value' }
      },
      'linux',
      {
        setup: {
          runnerScriptPath: '/tmp/setup.sh',
          envVars: { ORCA_WORKTREE_PATH: '/repo/worktree' },
          waitForAgentStartup: true
        }
      }
    )

    const setupLaunch = mockLaunchWorktreeBackgroundTerminals.mock.calls[0]?.[0]
    expect(setupLaunch).toMatchObject({
      worktreeId: 'wt-1',
      setup: expect.objectContaining({
        waitForAgentStartup: true,
        command: expect.stringContaining('/tmp/setup.sh.')
      })
    })
    const setupCommand = setupLaunch.setup.command as string
    const marker = setupCommand.match(/setup\.sh\.([0-9a-z-]+)\.done/)?.[0]
    expect(marker).toBeTruthy()
    expect(result.launchCommand).toContain(marker!)
    expect(result.launchCommand).toContain('Waiting for setup to finish before starting agent')
    expect(result.env).toEqual({
      EXISTING: 'value',
      ORCA_SEQUENCED_STARTUP_COMMAND: "claude 'run the automation'"
    })
  })
})
