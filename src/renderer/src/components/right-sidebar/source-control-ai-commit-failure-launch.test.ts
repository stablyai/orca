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

import { launchCommitFailureAgentWithDefault } from './source-control-ai-commit-failure-launch'

describe('launchCommitFailureAgentWithDefault', () => {
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
      launchCommitFailureAgentWithDefault({
        activeWorktreeId: 'wt-1',
        activeGroupId: 'group-1',
        activeSourceControlLaunchPlatform: 'darwin',
        commitFailureRecoveryPrompt: 'Fix this commit failure.',
        getLaunchActionRecipe: () => ({
          commandInputTemplate: '{basePrompt}',
          agentArgs: '--model "unterminated'
        }),
        getStoreState: () => ({
          settings: { defaultTuiAgent: 'codex', disabledTuiAgents: [] } as never,
          ensureDetectedAgents: mocks.ensureDetectedAgents,
          ensureRemoteDetectedAgents: mocks.ensureRemoteDetectedAgents
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
})
