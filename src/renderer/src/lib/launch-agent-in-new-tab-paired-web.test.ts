// Paired-web-client half of the launchAgentInNewTab suite: every launch is
// delegated to the host runtime through agentLaunch, never assembled client-side.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mockCreateTab,
  mockCreateWebRuntimeAgentSessionTerminal,
  mockCreateWebRuntimeAgentSessionTerminalWithLaunchDraft,
  mockCreateWebRuntimeSessionTerminal,
  mockIsWebRuntimeSessionActive,
  mockPasteDraftWhenAgentReady,
  mockQueueTabStartupCommand,
  mockSetActiveTabType,
  mockToastError,
  mockToastMessage,
  mockTrack,
  resetLaunchAgentInNewTabHarness,
  store
} from './launch-agent-in-new-tab-test-harness'

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => store
  }
}))

vi.mock('sonner', () => ({
  toast: { message: mockToastMessage, error: mockToastError }
}))

vi.mock('@/components/tab-bar/reconcile-order', () => ({
  reconcileTabOrder: vi.fn(
    (_stored, termIds: string[], editorIds: string[], browserIds: string[]) => [
      ...termIds,
      ...editorIds,
      ...browserIds
    ]
  )
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: mockPasteDraftWhenAgentReady
}))

vi.mock('@/lib/telemetry', () => ({
  track: mockTrack,
  tuiAgentToAgentKind: (agent: string) => agent
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionTerminal: mockCreateWebRuntimeSessionTerminal,
  createWebRuntimeAgentSessionTerminal: mockCreateWebRuntimeAgentSessionTerminal,
  createWebRuntimeAgentSessionTerminalWithLaunchDraft:
    mockCreateWebRuntimeAgentSessionTerminalWithLaunchDraft,
  isWebRuntimeSessionActive: mockIsWebRuntimeSessionActive,
  isWebTerminalSurfaceTabId: vi.fn(() => false)
}))

describe('launchAgentInNewTab in paired web clients', () => {
  beforeEach(() => {
    resetLaunchAgentInNewTabHarness()
  })

  it('delegates agent quick launch to the host runtime in paired web clients', async () => {
    mockIsWebRuntimeSessionActive.mockReturnValue(true)
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: 'web-runtime'
    }
    store.tabsByWorktree = {
      'wt-1': [
        { id: 'tab-1' },
        { id: 'stale-agent-tab', launchAgent: 'claude' } as { id: string; launchAgent: string }
      ]
    }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'claude',
      worktreeId: 'wt-1',
      groupId: 'group-1'
    })

    expect(result).toEqual(
      expect.objectContaining({
        tabId: null,
        pasteDraftAfterLaunch: false
      })
    )
    // Paired web launches route through the same host `agentLaunch` boundary as
    // the local path — identity + launch policy only, never a client command.
    expect(mockCreateWebRuntimeSessionTerminal).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      environmentId: 'web-runtime',
      targetGroupId: 'group-1',
      activate: true,
      agentLaunch: {
        selection: { kind: 'agent', agent: 'claude' },
        allowEmptyPromptLaunch: true
      },
      viewMode: 'terminal'
    })
    expect(mockCreateTab).not.toHaveBeenCalled()
    expect(mockQueueTabStartupCommand).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(mockSetActiveTabType).toHaveBeenCalledWith('terminal')
    expect(store.closeTab).toHaveBeenCalledWith('stale-agent-tab', {
      reason: 'cleanup'
    })
  })

  it('mirrors a paired-host draft while keeping launch assembly host-owned', async () => {
    mockIsWebRuntimeSessionActive.mockReturnValue(true)
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: 'web-runtime'
    }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'review before sending',
      promptDelivery: 'draft'
    })

    expect(result).toEqual(expect.objectContaining({ tabId: null, pasteDraftAfterLaunch: false }))
    expect(mockCreateWebRuntimeAgentSessionTerminalWithLaunchDraft).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      environmentId: 'web-runtime',
      targetGroupId: undefined,
      activate: true,
      agentLaunch: {
        selection: { kind: 'agent', agent: 'claude' },
        prompt: 'review before sending',
        promptDelivery: 'draft'
      },
      viewMode: 'terminal',
      agent: 'claude',
      launchDraft: 'review before sending'
    })
    expect(mockCreateWebRuntimeSessionTerminal).not.toHaveBeenCalled()
    expect(mockCreateTab).not.toHaveBeenCalled()
  })

  it('forwards a prompt launch to paired web runtime hosts through agentLaunch only', async () => {
    mockIsWebRuntimeSessionActive.mockReturnValue(true)
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: { codex: '--model gpt-5 --reasoning-effort high' },
      agentDefaultEnv: { codex: { CODEX_PROFILE: 'captured' } },
      activeRuntimeEnvironmentId: 'web-runtime'
    }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: 'fix the spinner',
      groupId: 'group-1'
    })

    expect(result).toEqual(
      expect.objectContaining({
        tabId: null,
        pasteDraftAfterLaunch: false
      })
    )
    // The host owns argv/env/config assembly (including captured agentDefaultArgs
    // /agentDefaultEnv); the request carries identity + folded prompt only.
    expect(mockCreateWebRuntimeSessionTerminal).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      environmentId: 'web-runtime',
      targetGroupId: 'group-1',
      activate: true,
      agentLaunch: {
        selection: { kind: 'agent', agent: 'codex' },
        prompt: 'fix the spinner'
      },
      viewMode: 'terminal'
    })
    expect(mockCreateTab).not.toHaveBeenCalled()
    expect(mockQueueTabStartupCommand).not.toHaveBeenCalled()
  })

  it('propagates the default chat mode to paired web runtime launches', async () => {
    mockIsWebRuntimeSessionActive.mockReturnValue(true)
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: 'web-runtime',
      experimentalNativeChat: true,
      openAgentTabsInChatByDefault: true
    }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })

    expect(mockCreateWebRuntimeSessionTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'wt-1',
        environmentId: 'web-runtime',
        agentLaunch: {
          selection: { kind: 'agent', agent: 'codex' },
          allowEmptyPromptLaunch: true
        },
        viewMode: 'chat'
      })
    )
  })

  it('propagates the resolved terminal mode to paired web runtime launches', async () => {
    mockIsWebRuntimeSessionActive.mockReturnValue(true)
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: 'web-runtime',
      experimentalNativeChat: true,
      openAgentTabsInChatByDefault: false
    }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })

    expect(mockCreateWebRuntimeSessionTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'wt-1',
        environmentId: 'web-runtime',
        agentLaunch: {
          selection: { kind: 'agent', agent: 'codex' },
          allowEmptyPromptLaunch: true
        },
        viewMode: 'terminal'
      })
    )
  })

  it('surfaces a toast when host agent launch fails in paired web clients', async () => {
    mockIsWebRuntimeSessionActive.mockReturnValue(true)
    mockCreateWebRuntimeSessionTerminal.mockResolvedValue({
      status: 'failed',
      message: 'Upgrade the remote Orca host before starting or resuming agent sessions.'
    })
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: 'web-runtime'
    }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      agent: 'claude',
      worktreeId: 'wt-1'
    })

    await Promise.resolve()
    expect(mockToastError).toHaveBeenCalledWith(
      'Upgrade the remote Orca host before starting or resuming agent sessions.'
    )
    expect(mockSetActiveTabType).not.toHaveBeenCalled()
  })
})
