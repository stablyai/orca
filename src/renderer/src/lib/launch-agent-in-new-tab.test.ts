import { EVERY_AGENT_CHAT } from '../../../shared/native-chat/every-agent-chat.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import {
  mockCreateTab,
  queuedStartups,
  mockSetActiveTabType,
  mockSetTabViewMode,
  mockSetAgentStatus,
  mockPasteDraftWhenAgentReady,
  mockSeedNativeChatLaunchPrompt,
  mockSeedNativeChatLaunchDraft,
  mockTrack,
  mockToastMessage,
  LEAF_ID,
  store,
  mockToastError,
  mockCreateWebRuntimeSessionTerminal,
  mockCreateWebRuntimeAgentSessionTerminalWithLaunchDraft,
  mockIsWebRuntimeSessionActive,
  COMMAND_CODE_CLICK
} from './launch-agent-in-new-tab-test-fixture'
import { toAppSshPtyId } from '../../../shared/ssh-pty-id'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'

describe('launchAgentInNewTab', () => {
  it('stamps the launched agent on the new tab for immediate provider icon bootstrap', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
    const cancelFocus = vi.fn()

    launchAgentInNewTab({
      requestId: 'request-1',
      agent: 'codex',
      worktreeId: 'wt-1',
      focusIntent: { request: vi.fn(), cancel: cancelFocus }
    })

    expect(cancelFocus).toHaveBeenCalledOnce()
    expect(mockCreateTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      launchAgent: 'codex',
      pendingStartup: expect.anything()
    })
  })
  it('keeps Floating Workspace authority on native Windows beside an active WSL project', async () => {
    store.projects = [
      {
        id: 'repo-1',
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
      }
    ]
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-2',
      agent: 'codex',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      launchPlatform: 'win32'
    })

    expect(result).not.toBeNull()
    expect(mockIsWebRuntimeSessionActive).toHaveBeenLastCalledWith(null)
    expect(mockCreateWebRuntimeSessionTerminal).not.toHaveBeenCalled()
    expect(mockCreateTab).toHaveBeenCalledWith(
      FLOATING_TERMINAL_WORKTREE_ID,
      undefined,
      undefined,
      { launchAgent: 'codex', pendingStartup: expect.anything() }
    )
  })

  it('keeps prompted resolved-CLI Codex launches on their owned pane path', async () => {
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: null,
      nativeChatProviders: EVERY_AGENT_CHAT
    }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      requestId: 'request-3',
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: 'large generated prompt',
      promptDelivery: 'submit-after-ready'
    })

    expect(mockCreateTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      launchAgent: 'codex',
      quickCommandLabel: undefined,
      id: 'tab-1',
      initialLeafId: 'tab-1',
      agentLaunchPane: { leafId: 'tab-1' },
      pendingStartup: expect.anything()
    })
    expect(queuedStartups()).toContainEqual(
      expect.objectContaining({
        command: expect.not.stringContaining('large generated prompt')
      })
    )
    await vi.waitFor(() => {
      expect(mockSeedNativeChatLaunchPrompt).toHaveBeenCalledWith({
        tabId: 'tab-1',
        agent: 'codex',
        text: 'large generated prompt',
        createdAt: expect.any(Number)
      })
    })
    expect(mockSetTabViewMode).not.toHaveBeenCalled()
  })

  it('keeps unsupported Grok submit-after-ready launches on their owned terminal path', async () => {
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: null,
      nativeChatProviders: EVERY_AGENT_CHAT
    }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      requestId: 'request-4',
      agent: 'grok',
      worktreeId: 'wt-1',
      prompt: 'large generated prompt',
      promptDelivery: 'submit-after-ready'
    })

    expect(mockCreateTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      launchAgent: 'grok',
      quickCommandLabel: undefined,
      id: 'tab-1',
      initialLeafId: 'tab-1',
      agentLaunchPane: { leafId: 'tab-1' },
      pendingStartup: expect.anything()
    })
    await vi.waitFor(() => {
      expect(mockSeedNativeChatLaunchPrompt).toHaveBeenCalledWith({
        tabId: 'tab-1',
        agent: 'grok',
        text: 'large generated prompt',
        createdAt: expect.any(Number)
      })
    })
  })

  it('keeps Model-A SSH Grok launches in terminal mode', async () => {
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: null,
      nativeChatProviders: EVERY_AGENT_CHAT
    }
    store.repos = [{ id: 'repo-1', connectionId: 'ssh-target-1', path: '/repo' }]
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ requestId: 'request-5', agent: 'grok', worktreeId: 'wt-1' })

    expect(mockCreateTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      launchAgent: 'grok',
      quickCommandLabel: undefined,
      pendingStartup: expect.anything()
    })
  })

  it('mirrors an argv-prefill draft into chat and opens the tab there', async () => {
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: null,
      nativeChatProviders: EVERY_AGENT_CHAT
    }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-6',
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'https://github.com/o/r/issues/12',
      promptDelivery: 'draft'
    })

    expect(result?.pasteDraftAfterLaunch).toBe(false)
    expect(mockSeedNativeChatLaunchDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'tab-1',
        agent: 'claude',
        text: 'https://github.com/o/r/issues/12'
      })
    )
    expect(mockCreateTab.mock.calls[0]?.[3]).not.toHaveProperty('viewMode')
  })

  it('mirrors a multi-line draft into chat without opening the tab there', async () => {
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: null,
      nativeChatProviders: EVERY_AGENT_CHAT
    }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const prompt = 'Reproduce first\n\nhttps://github.com/o/r/issues/12'
    launchAgentInNewTab({
      requestId: 'request-7',
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt,
      promptDelivery: 'draft'
    })

    expect(mockSeedNativeChatLaunchDraft).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 'tab-1', agent: 'claude', text: prompt })
    )
    expect(mockCreateTab.mock.calls[0]?.[3]).not.toHaveProperty('viewMode')
  })

  it('passes quick command labels only to locally-created agent tabs', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      requestId: 'request-8',
      agent: 'codex',
      worktreeId: 'wt-1',
      quickCommandLabel: 'Review'
    })

    expect(mockCreateTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      launchAgent: 'codex',
      quickCommandLabel: 'Review',
      pendingStartup: expect.anything()
    })
  })

  it('does not inject native-chat model preferences into terminal Quick Commands', async () => {
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: { codex: '--profile team' },
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: null,
      nativeChatProviders: {},
      nativeChatSessionOptions: {
        codex: {
          model: 'gpt-5.2-codex',
          valuesByModel: { 'gpt-5.2-codex': { effort: 'medium' } }
        }
      }
    }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      requestId: 'request-9',
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: 'Review this diff',
      launchSource: 'quick_command',
      quickCommandLabel: 'Review'
    })

    const launch = queuedStartups()[0]
    expect(launch.command).toContain("'--profile' 'team'")
    expect(launch.command).not.toContain("'-m'")
    expect(launch.command).not.toContain('model_reasoning_effort=')
    expect(launch.sessionOptions).toBeUndefined()
  })

  it('keeps Chat UI model preferences out of a terminal fallback launch', async () => {
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: null,
      nativeChatProviders: EVERY_AGENT_CHAT,
      nativeChatSessionOptions: {
        codex: {
          model: 'gpt-5.2-codex',
          valuesByModel: { 'gpt-5.2-codex': { effort: 'medium' } }
        }
      }
    }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      requestId: 'request-10',
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: 'Review this diff',
      launchSource: 'quick_command',
      quickCommandLabel: 'Review'
    })

    const launch = queuedStartups()[0]
    expect(launch.command).not.toContain("'-m'")
    expect(launch.command).not.toContain('model_reasoning_effort=')
    expect(launch.sessionOptions).toBeUndefined()
    expect(mockCreateTab).toHaveBeenCalledWith(
      'wt-1',
      undefined,
      undefined,
      expect.objectContaining({ launchAgent: 'codex' })
    )
    expect(mockCreateTab.mock.calls[0]?.[3]).not.toHaveProperty('viewMode')
    expect(mockSetTabViewMode).not.toHaveBeenCalled()
  })

  it('preserves paired-host draft delivery without Chat UI launch preferences', async () => {
    mockIsWebRuntimeSessionActive.mockReturnValue(true)
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: 'web-runtime',
      nativeChatProviders: EVERY_AGENT_CHAT,
      nativeChatSessionOptions: {
        claude: {
          model: 'opus',
          valuesByModel: { opus: { effort: 'high', fastMode: true } }
        }
      }
    }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-11',
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'review before sending',
      promptDelivery: 'draft',
      agentArgs: '--permission-mode plan'
    })

    expect(result?.surface).toEqual({ kind: 'host-published' })
    expect(result?.pasteDraftAfterLaunch).toBe(false)
    await result?.terminalCompletion
    expect(mockCreateWebRuntimeAgentSessionTerminalWithLaunchDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        launchAgent: 'claude',
        prompt: 'review before sending',
        promptDelivery: 'draft',
        agentArgs: '--permission-mode plan',
        agent: 'claude',
        launchDraft: 'review before sending'
      })
    )
    expect(
      mockCreateWebRuntimeAgentSessionTerminalWithLaunchDraft.mock.calls[0]?.[0]
    ).not.toHaveProperty('launchPreferences')
    expect(mockCreateWebRuntimeSessionTerminal).not.toHaveBeenCalled()
    expect(mockCreateTab).not.toHaveBeenCalled()
  })

  it('propagates terminal UI to paired web runtime fallbacks', async () => {
    mockIsWebRuntimeSessionActive.mockReturnValue(true)
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: 'web-runtime',
      nativeChatProviders: EVERY_AGENT_CHAT
    }
    // The client stamps a server's rows on arrival; focus alone never names the owner.
    Object.assign(store.repos[0], { executionHostId: 'runtime:web-runtime' })
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-12',
      agent: 'codex',
      worktreeId: 'wt-1'
    })

    await result?.terminalCompletion
    expect(mockCreateWebRuntimeSessionTerminal.mock.calls[0]?.[0]).toMatchObject({
      worktreeId: 'wt-1',
      environmentId: 'web-runtime',
      agentSessionKind: 'fresh',
      launchAgent: 'codex',
      viewMode: 'terminal'
    })
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

    await launchAgentInNewTab({ requestId: 'request-14', agent: 'claude', worktreeId: 'wt-1' })
      ?.terminalCompletion
    expect(mockToastError).toHaveBeenCalledWith(expect.stringMatching(/Claude.*try again/))
    expect(mockSetActiveTabType).not.toHaveBeenCalled()
  })

  it('queues initial working status for Command Code argv prompt launches', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      ...COMMAND_CODE_CLICK,
      prompt: 'fix the spinner'
    })

    expect(queuedStartups()).toContainEqual(
      expect.objectContaining({
        command: "command-code --trust '--yolo' 'fix the spinner'",
        initialAgentStatus: {
          agent: 'command-code',
          prompt: 'fix the spinner'
        }
      })
    )
  })

  it('does not track prompt-sent for draft launches', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      requestId: 'request-16',
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'review this before sending',
      promptDelivery: 'draft'
    })

    expect(mockTrack).not.toHaveBeenCalledWith('agent_prompt_sent', expect.anything())
  })

  it('falls back to post-ready draft paste when a Windows inline draft would be too large', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
    const prompt = 'x'.repeat(25_000)

    const result = launchAgentInNewTab({
      requestId: 'request-17',
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt,
      promptDelivery: 'draft',
      launchPlatform: 'win32'
    })

    expect(result?.promptDeliveryResult).toBeDefined()
    expect(queuedStartups()).toContainEqual(
      expect.objectContaining({
        command: "claude '--dangerously-skip-permissions'"
      })
    )
    expect(mockPasteDraftWhenAgentReady).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'tab-1',
        content: prompt,
        agent: 'claude',
        submit: false,
        forcePaste: true
      })
    )
  })

  it('exposes rejected draft delivery while keeping its existing error observer', async () => {
    const error = new Error('paste failed')
    const originalConsole = console
    const consoleError = vi.fn()
    vi.stubGlobal('console', { ...originalConsole, error: consoleError })
    mockPasteDraftWhenAgentReady.mockRejectedValue(error)
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
    const prompt = 'x'.repeat(25_000)

    try {
      const result = launchAgentInNewTab({
        requestId: 'request-18',
        agent: 'claude',
        worktreeId: 'wt-1',
        prompt,
        promptDelivery: 'draft',
        launchPlatform: 'win32'
      })

      await expect(result?.promptDeliveryResult).rejects.toBe(error)
      expect(consoleError).toHaveBeenCalledWith('Prompt delivery failed after launch', error)
    } finally {
      vi.stubGlobal('console', originalConsole)
    }
  })

  it('seeds working after Command Code submit-after-ready prompt delivery', async () => {
    store.repos = [{ id: 'repo-1', connectionId: 'ssh-a', path: '/repo' }]
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      ...COMMAND_CODE_CLICK,
      prompt: 'large generated prompt',
      promptDelivery: 'submit-after-ready'
    })
    store.terminalLayoutsByTabId = {
      'tab-1': {
        activeLeafId: LEAF_ID,
        ptyIdsByLeafId: { [LEAF_ID]: toAppSshPtyId('ssh-a', 'pty-1') }
      }
    }
    store.ptyIdsByTabId = { 'tab-1': [toAppSshPtyId('ssh-a', 'pty-1')] }
    await expect(result?.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(queuedStartups()).toContainEqual(
      expect.objectContaining({
        command: "command-code --trust '--yolo'"
      })
    )
    expect(mockPasteDraftWhenAgentReady).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'tab-1',
        content: 'large generated prompt',
        agent: 'command-code',
        submit: true,
        forcePaste: true
      })
    )
    expect(mockSetAgentStatus).toHaveBeenCalledWith(
      `tab-1:${LEAF_ID}`,
      {
        state: 'working',
        prompt: 'large generated prompt',
        agentType: 'command-code',
        // Why: seeded from Orca's own prompt delivery, not a provider hook (STA-4293).
        observation: expect.objectContaining({ origin: 'process', kind: 'transition' })
      },
      undefined,
      undefined,
      { connectionId: 'ssh-a' }
    )
    expect(mockTrack).not.toHaveBeenCalledWith('agent_prompt_sent', expect.anything())
  })

  it('does not recreate SSH status when clear arrives before disconnect state', async () => {
    let finishDelivery: ((delivered: boolean) => void) | undefined
    mockPasteDraftWhenAgentReady.mockReturnValue(
      new Promise<boolean>((resolve) => {
        finishDelivery = resolve
      })
    )
    store.repos = [{ id: 'repo-1', connectionId: 'ssh-a', path: '/repo' }]
    const ptyId = toAppSshPtyId('ssh-a', 'pty-1')
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      ...COMMAND_CODE_CLICK,
      prompt: 'pending prompt',
      promptDelivery: 'submit-after-ready'
    })
    store.terminalLayoutsByTabId = {
      'tab-1': { activeLeafId: LEAF_ID, ptyIdsByLeafId: { [LEAF_ID]: ptyId } }
    }
    store.ptyIdsByTabId = { 'tab-1': [ptyId] }

    // Disconnect clears status before the state event, while the old binding can still appear connected.
    store.transientClearedAgentStatusConnectionIds = { 'ssh-a': true }
    finishDelivery?.(true)
    await expect(result?.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })

    expect(mockSetAgentStatus).not.toHaveBeenCalled()
  })

  it('does not track prompt-sent when submit-after-ready delivery fails', async () => {
    mockPasteDraftWhenAgentReady.mockResolvedValue(false)
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      ...COMMAND_CODE_CLICK,
      prompt: 'large generated prompt',
      promptDelivery: 'submit-after-ready'
    })
    await expect(result?.promptDeliveryResult).resolves.toEqual({
      delivered: false,
      failureNotified: false
    })
    await Promise.resolve()

    expect(mockTrack).not.toHaveBeenCalledWith('agent_prompt_sent', expect.anything())
  })

  it('marks failed submit-after-ready delivery as notified after readiness timeout toast', async () => {
    mockPasteDraftWhenAgentReady.mockImplementation(({ onTimeout }) => {
      onTimeout?.()
      return Promise.resolve(false)
    })
    store.tabsByWorktree = { 'wt-1': [{ id: 'tab-1', ptyId: 'pty-1' } as never] }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      ...COMMAND_CODE_CLICK,
      prompt: 'large generated prompt',
      promptDelivery: 'submit-after-ready'
    })

    await expect(result?.promptDeliveryResult).resolves.toEqual({
      delivered: false,
      failureNotified: true
    })
    expect(mockToastMessage).toHaveBeenCalledWith(
      "Your prompt wasn't sent — paste it once the agent is ready."
    )
  })

  it('marks a cancelled submit-after-ready launch notified when the user closed the tab', async () => {
    mockPasteDraftWhenAgentReady.mockImplementation(({ onTimeout }) => {
      onTimeout?.()
      return Promise.resolve(false)
    })
    store.tabsByWorktree = { 'wt-1': [] }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      ...COMMAND_CODE_CLICK,
      prompt: 'large generated prompt',
      promptDelivery: 'submit-after-ready'
    })

    await expect(result?.promptDeliveryResult).resolves.toEqual({
      delivered: false,
      failureNotified: true
    })
  })

  it('marks a cancelled submit-after-ready launch notified when the user switched worktrees', async () => {
    mockPasteDraftWhenAgentReady.mockImplementation(({ onTimeout }) => {
      onTimeout?.()
      return Promise.resolve(false)
    })
    store.tabsByWorktree = { 'wt-1': [{ id: 'tab-1', ptyId: 'pty-1' } as never] }
    store.activeWorktreeId = 'wt-2'
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      ...COMMAND_CODE_CLICK,
      prompt: 'large generated prompt',
      promptDelivery: 'submit-after-ready'
    })

    await expect(result?.promptDeliveryResult).resolves.toEqual({
      delivered: false,
      failureNotified: true
    })
  })

  it('leaves a genuine launch failure unnotified so the caller surfaces it', async () => {
    mockPasteDraftWhenAgentReady.mockImplementation(({ onTimeout }) => {
      onTimeout?.()
      return Promise.resolve(false)
    })
    store.tabsByWorktree = { 'wt-1': [{ id: 'tab-1', ptyId: null } as never] }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      ...COMMAND_CODE_CLICK,
      prompt: 'large generated prompt',
      promptDelivery: 'submit-after-ready'
    })

    await expect(result?.promptDeliveryResult).resolves.toEqual({
      delivered: false,
      failureNotified: false
    })
    expect(mockToastMessage).not.toHaveBeenCalled()
  })

  it('queues per-launch CLI arguments without putting generated prompts in argv', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      requestId: 'request-26',
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: 'large generated prompt',
      agentArgs: '--model gpt-5.5',
      promptDelivery: 'submit-after-ready'
    })

    expect(queuedStartups()).toContainEqual(
      expect.objectContaining({
        command: '',
        agentLaunch: {
          launch: {
            agent: 'codex',
            target: { kind: 'existing', worktree: 'id:wt-1' },
            agentArgs: '--model gpt-5.5',
            launchSource: 'tab_bar_quick_launch'
          },
          suppressStartupUpdatePrompt: true
        }
      })
    )
  })
})
