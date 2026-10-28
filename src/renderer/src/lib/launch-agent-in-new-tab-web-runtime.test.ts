import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as StructuredAgentSessionClientModule from '@/runtime/structured-agent-session-client'

vi.mock('@/runtime/structured-agent-session-client', async (importOriginal) => ({
  ...(await importOriginal<typeof StructuredAgentSessionClientModule>()),
  callStructuredAgentSession: vi.fn(async () => ({ supported: false }))
}))

const mocks = vi.hoisted(() => ({
  createTab: vi.fn(),
  closeTab: vi.fn(),
  createWebRuntimeSessionTerminal: vi.fn(),
  deliverLaunchPromptToAgentTab: vi.fn(),
  setActiveTabType: vi.fn(),
  toastInfo: vi.fn(),
  toastError: vi.fn()
}))

const store = {
  activeRepoId: 'repo-1',
  activeWorktreeId: 'wt-1',
  settings: {
    agentCmdOverrides: {} as Record<string, string>,
    agentDefaultArgs: {} as Record<string, string>,
    agentDefaultEnv: {} as Record<string, Record<string, string>>,
    activeRuntimeEnvironmentId: 'web-runtime' as string | null
  },
  projects: [{ id: 'repo-1', localWindowsRuntimePreference: { kind: 'inherit-global' as const } }],
  // The client stamps a server's rows on arrival; focus alone never names the owner.
  repos: [
    { id: 'repo-1', connectionId: null, path: '/repo', executionHostId: 'runtime:web-runtime' }
  ],
  worktreesByRepo: {
    'repo-1': [
      {
        id: 'wt-1',
        repoId: 'repo-1',
        projectId: 'repo-1',
        path: '/repo/worktree',
        displayName: 'main'
      }
    ]
  },
  tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] as { id: string; launchAgent?: string }[] },
  openFiles: [] as { id: string; worktreeId: string }[],
  browserTabsByWorktree: {} as Record<string, { id: string }[]>,
  tabBarOrderByWorktree: {} as Record<string, string[]>,
  terminalLayoutsByTabId: {},
  ptyIdsByTabId: {},
  sshConnectionStates: new Map(),
  sshStateByEnvironment: new Map(),
  runtimeStatusByEnvironmentId: new Map([['web-runtime', { status: { hostPlatform: 'linux' } }]]),
  runtimeDetectedAgentIds: {},
  runtimeAgentDetectionNeedsServerUpdate: {},
  runtimeAgentInventoryOutcome: () => 'pending' as const,
  transientClearedAgentStatusConnectionIds: {},
  allWorktrees: vi.fn(() => store.worktreesByRepo['repo-1']),
  createTab: mocks.createTab,
  closeTab: mocks.closeTab,
  queueTabStartupCommand: vi.fn(),
  setActiveTabType: mocks.setActiveTabType,
  setTabBarOrder: vi.fn(),
  setAgentStatus: vi.fn(),
  seedNativeChatLaunchPrompt: vi.fn(),
  markNativeChatLaunchPromptFailed: vi.fn()
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('sonner', () => ({
  toast: { message: vi.fn(), error: mocks.toastError, info: mocks.toastInfo }
}))
vi.mock('@/components/tab-bar/reconcile-order', () => ({ reconcileTabOrder: vi.fn(() => []) }))
vi.mock('@/lib/agent-paste-draft', () => ({ pasteDraftWhenAgentReady: vi.fn() }))
vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))
vi.mock('@/runtime/web-runtime-terminal-create-operation', () => ({
  createWebRuntimeSessionTerminalResult: mocks.createWebRuntimeSessionTerminal
}))
vi.mock('@/lib/agent-launch-prompt-delivery', () => ({
  deliverLaunchPromptToAgentTab: mocks.deliverLaunchPromptToAgentTab,
  seedNativeChatLaunchDraftForAgentTab: vi.fn()
}))
vi.mock('@/runtime/web-runtime-session-environment', () => ({
  isWebRuntimeSessionActive: vi.fn(() => true)
}))

describe('launchAgentInNewTab paired web runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: 'web-runtime'
    }
    store.tabsByWorktree = { 'wt-1': [{ id: 'tab-1' }] }
    mocks.deliverLaunchPromptToAgentTab.mockResolvedValue(true)
    mocks.createWebRuntimeSessionTerminal.mockResolvedValue({
      outcome: { status: 'created' },
      hostTabId: 'host-tab::leaf-1'
    })
  })

  it.each([true, false, 'failed'] as const)('delegates agent quick launch (%s)', async (mode) => {
    store.settings.agentDefaultArgs = { claude: '--model "model with spaces"' }
    const activate = mode === true
    const status = mode === 'failed' ? 'failed' : 'created'
    mocks.createWebRuntimeSessionTerminal.mockResolvedValue({
      outcome: {
        status,
        ...(status === 'failed' ? { message: 'The host refused the launch.' } : {})
      },
      hostTabId: 'host-tab::leaf-1'
    })
    store.tabsByWorktree['wt-1'].push({ id: 'local-agent-tab', launchAgent: 'claude' })
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-1',
      activate,
      agent: 'claude',
      worktreeId: 'wt-1',
      groupId: 'group-1',
      initialCwd: '/repo/worktree/packages/app'
    })

    expect(result).toEqual(
      expect.objectContaining({
        surface: { kind: 'host-published' },
        pasteDraftAfterLaunch: false
      })
    )
    const startupPlan = result?.startupPlan
    expect(startupPlan).toBeDefined()
    if (!startupPlan) {
      throw new Error('Expected the terminal startup plan')
    }
    expect(mocks.createWebRuntimeSessionTerminal).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      environmentId: 'web-runtime',
      targetGroupId: 'group-1',
      cwd: '/repo/worktree/packages/app',
      activate,
      ...(activate ? {} : { selectWorktree: false }),
      agentSessionKind: 'fresh',
      launchAgent: 'claude',
      preparedAgentCommand: false,
      command: startupPlan.launchCommand,
      env: startupPlan.env,
      launchConfig: startupPlan.launchConfig,
      viewMode: 'terminal'
    })
    expect(startupPlan.launchConfig.agentArgs).toBe(store.settings.agentDefaultArgs.claude)
    expect(mocks.createTab).not.toHaveBeenCalled()
    await expect(result?.terminalCompletion).resolves.toMatchObject({
      outcome: { status },
      ...(status === 'created' ? { tabId: 'web-terminal-host-tab' } : {})
    })
    expect(mocks.setActiveTabType).toHaveBeenCalledTimes(activate && status === 'created' ? 1 : 0)
    expect(mocks.toastError).toHaveBeenCalledTimes(status === 'failed' ? 1 : 0)
    if (status === 'failed') {
      expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith('The host refused the launch.')
    }
    // A local tab closes locally (the host close no-ops), so a launch leaves it alone.
    expect(mocks.closeTab).not.toHaveBeenCalled()
  })

  it('forwards prompt launch env and captured config to the host runtime', async () => {
    store.settings.agentDefaultArgs = { codex: '--model gpt-5 --reasoning-effort high' }
    store.settings.agentDefaultEnv = { codex: { CODEX_PROFILE: 'captured' } }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-2',
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: 'fix the spinner',
      groupId: 'group-1'
    })

    expect(result).toEqual(
      expect.objectContaining({
        surface: { kind: 'host-published' },
        pasteDraftAfterLaunch: false
      })
    )
    expect(mocks.createWebRuntimeSessionTerminal).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      environmentId: 'web-runtime',
      targetGroupId: 'group-1',
      activate: true,
      agentSessionKind: 'fresh',
      launchAgent: 'codex',
      preparedAgentCommand: false,
      command: "codex '--model' 'gpt-5' '--reasoning-effort' 'high' 'fix the spinner'",
      env: { CODEX_PROFILE: 'captured' },
      launchConfig: {
        agentCommand: "codex '--model' 'gpt-5' '--reasoning-effort' 'high'",
        agentArgs: '--model gpt-5 --reasoning-effort high',
        agentEnv: { CODEX_PROFILE: 'captured' }
      },
      startupCommandDelivery: 'shell-ready',
      prompt: 'fix the spinner',
      promptDelivery: 'auto-submit',
      viewMode: 'terminal'
    })
    expect(mocks.createTab).not.toHaveBeenCalled()
  })

  it('delivers submit-after-ready prompts on the paired host instead of creating a local tab', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'submit-after-ready',
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'continue the unfinished task',
      promptDelivery: 'submit-after-ready'
    })

    expect(mocks.createWebRuntimeSessionTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'wt-1',
        environmentId: 'web-runtime',
        agent: 'claude',
        promptAfterReady: 'continue the unfinished task',
        submitPrompt: true,
        forcePromptPaste: true
      })
    )
    expect(mocks.createTab).not.toHaveBeenCalled()
    await expect(result?.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false,
      outcome: { status: 'created' }
    })
    expect(mocks.deliverLaunchPromptToAgentTab).toHaveBeenCalledExactlyOnceWith({
      tabId: 'web-terminal-host-tab%3A%3Aleaf-1',
      content: 'continue the unfinished task',
      agent: 'claude',
      submit: true,
      forcePaste: true
    })
  })

  it.each(['created', 'failed'] as const)(
    'settles declined new-tab launch after %s receipt',
    async (status) => {
      const { adoptAgentSessionLaunchVerdict } = await import('./agent-session-launch-plan')
      const { launchStructuredAgentFromNewTab } =
        await import('./launch-agent-in-new-tab-structured-route')
      const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
      let finish!: (created: { outcome: { status: string; message: string } }) => void
      mocks.createWebRuntimeSessionTerminal.mockReturnValue(
        new Promise((resolve) => (finish = resolve))
      )
      const result = launchStructuredAgentFromNewTab({
        plan: adoptAgentSessionLaunchVerdict({
          requestId: 'declined-receipt',
          route: 'structured-native-chat',
          agent: 'claude',
          executionHostId: 'runtime:web-runtime',
          worktreeId: 'wt-1'
        }),
        worktreeId: 'wt-1',
        openTerminal: (agentSessionLaunchPlan) =>
          launchAgentInNewTab({ agent: 'claude', worktreeId: 'wt-1', agentSessionLaunchPlan })
      })
      await vi.waitFor(() => expect(mocks.createWebRuntimeSessionTerminal).toHaveBeenCalledOnce())
      expect(mocks.toastInfo).not.toHaveBeenCalled()
      finish({ outcome: { status, message: 'Could not create terminal' } })
      await expect(result?.structuredSettlement).resolves.toEqual(
        status === 'created' ? { kind: 'terminal' } : { kind: 'cancelled', sessionId: null }
      )
      expect(mocks.toastInfo).toHaveBeenCalledTimes(status === 'created' ? 1 : 0)
      expect(mocks.closeTab).not.toHaveBeenCalled()
    }
  )
})
