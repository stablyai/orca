import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SourceControlLaunchAgentSelectionModule from '@/lib/source-control-launch-agent-selection'

const mocks = vi.hoisted(() => ({
  ensureDetectedAgents: vi.fn(),
  ensureRemoteDetectedAgents: vi.fn(),
  focusTerminalTabSurface: vi.fn(),
  getConnectionId: vi.fn(),
  launchAgentInNewTab: vi.fn(),
  pickSourceControlLaunchAgent: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess
  }
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: mocks.getConnectionId
}))

vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: mocks.focusTerminalTabSurface
}))

vi.mock('@/lib/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab: mocks.launchAgentInNewTab
}))

vi.mock('@/lib/source-control-launch-agent-selection', async () => {
  const actual = await vi.importActual<typeof SourceControlLaunchAgentSelectionModule>(
    '@/lib/source-control-launch-agent-selection'
  )
  return {
    ...actual,
    pickSourceControlLaunchAgent: mocks.pickSourceControlLaunchAgent
  }
})

import { launchSourceControlRecoveryAgentWithDefault } from './source-control-ai-recovery-launch'

const copy = {
  promptUnavailable: 'Could not build the agent prompt.',
  emptyPrompt: 'Recovery prompt is empty.',
  savedAgentUnavailable: 'Saved AI agent is unavailable.',
  noEnabledAgent: 'No enabled AI agents.',
  launchCommandUnavailable: 'Could not build the agent launch command.',
  connectionUnavailable: 'Unable to resolve the workspace connection.',
  success: 'Started an AI agent for the recovery.'
}

function launchRecovery(
  overrides: Partial<Parameters<typeof launchSourceControlRecoveryAgentWithDefault>[0]> = {}
): Promise<boolean> {
  return launchSourceControlRecoveryAgentWithDefault({
    activeWorktreeId: 'wt-1',
    activeGroupId: 'group-1',
    activeSourceControlLaunchPlatform: 'darwin',
    actionId: 'fixCommitFailure',
    basePrompt: 'Fix this commit failure.',
    getLaunchActionRecipe: () => ({
      commandInputTemplate: '{basePrompt}'
    }),
    getStoreState: () => ({
      settings: { defaultTuiAgent: 'codex', disabledTuiAgents: [] } as never,
      ensureDetectedAgents: mocks.ensureDetectedAgents,
      ensureRemoteDetectedAgents: mocks.ensureRemoteDetectedAgents
    }),
    copy,
    ...overrides
  })
}

describe('launchSourceControlRecoveryAgentWithDefault', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getConnectionId.mockReturnValue(null)
    mocks.ensureDetectedAgents.mockResolvedValue(['codex'])
    mocks.ensureRemoteDetectedAgents.mockResolvedValue(['codex'])
    mocks.pickSourceControlLaunchAgent.mockReturnValue('codex')
    mocks.launchAgentInNewTab.mockReturnValue({ tabId: 'tab-1' })
  })

  it('rejects invalid saved CLI arguments before detecting agents', async () => {
    await expect(
      launchRecovery({
        getLaunchActionRecipe: () => ({
          commandInputTemplate: '{basePrompt}',
          agentArgs: '--model "unterminated'
        })
      })
    ).resolves.toBe(false)

    expect(mocks.ensureDetectedAgents).not.toHaveBeenCalled()
    expect(mocks.ensureRemoteDetectedAgents).not.toHaveBeenCalled()
    expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith(
      'CLI arguments are invalid: Unclosed quote in command template.'
    )
  })

  it('treats a null worktree connection as proven local and does not fall back to SSH', async () => {
    mocks.getConnectionId.mockReturnValue(null)

    await expect(launchRecovery({ sourceRepoConnectionId: 'ssh-1' })).resolves.toBe(true)

    expect(mocks.ensureDetectedAgents).toHaveBeenCalledTimes(1)
    expect(mocks.ensureRemoteDetectedAgents).not.toHaveBeenCalled()
    expect(mocks.launchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'Fix this commit failure.' })
    )
    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith('tab-1')
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Started an AI agent for the recovery.')
  })

  it('uses the owning SSH connection when the worktree has one', async () => {
    mocks.getConnectionId.mockReturnValue('ssh-worktree')

    await expect(launchRecovery()).resolves.toBe(true)

    expect(mocks.ensureRemoteDetectedAgents).toHaveBeenCalledWith('ssh-worktree')
    expect(mocks.ensureDetectedAgents).not.toHaveBeenCalled()
  })

  it('falls back to the repo connection only when the worktree connection is unresolved', async () => {
    mocks.getConnectionId.mockReturnValue(undefined)

    await expect(launchRecovery({ sourceRepoConnectionId: 'ssh-repo' })).resolves.toBe(true)

    expect(mocks.ensureRemoteDetectedAgents).toHaveBeenCalledWith('ssh-repo')
  })

  it('errors when both worktree and repo connections are unresolved', async () => {
    mocks.getConnectionId.mockReturnValue(undefined)

    await expect(launchRecovery({ sourceRepoConnectionId: undefined })).resolves.toBe(false)

    expect(mocks.toastError).toHaveBeenCalledWith('Unable to resolve the workspace connection.')
    expect(mocks.ensureDetectedAgents).not.toHaveBeenCalled()
    expect(mocks.ensureRemoteDetectedAgents).not.toHaveBeenCalled()
  })

  it('rejects empty rendered prompts before detecting agents', async () => {
    await expect(
      launchRecovery({
        getLaunchActionRecipe: () => ({
          commandInputTemplate: '   '
        })
      })
    ).resolves.toBe(false)

    expect(mocks.toastError).toHaveBeenCalledWith('Recovery prompt is empty.')
    expect(mocks.ensureDetectedAgents).not.toHaveBeenCalled()
  })

  it('rejects unavailable saved agents before terminal launch', async () => {
    mocks.ensureDetectedAgents.mockResolvedValue(['claude'])

    await expect(
      launchRecovery({
        getLaunchActionRecipe: () => ({
          agentId: 'codex',
          commandInputTemplate: '{basePrompt}'
        })
      })
    ).resolves.toBe(false)

    expect(mocks.toastError).toHaveBeenCalledWith('Saved AI agent is unavailable.')
    expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
  })
})
