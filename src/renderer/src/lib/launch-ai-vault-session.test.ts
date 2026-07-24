import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockCreateTab = vi.fn()
const mockCreateEmptySplitGroup = vi.fn()
const mockQueueTabStartupCommand = vi.fn()
const mockSetActiveTabType = vi.fn()
const mockSetTabBarOrder = vi.fn()
const runtimeMocks = vi.hoisted(() => ({
  createWebRuntimeSessionTerminal: vi.fn(),
  getRuntimeEnvironmentIdForWorktree: vi.fn<() => string | null>(() => null),
  isWebRuntimeSessionActive: vi.fn(() => false)
}))

const mockState = {
  createTab: mockCreateTab,
  createEmptySplitGroup: mockCreateEmptySplitGroup,
  queueTabStartupCommand: mockQueueTabStartupCommand,
  setActiveTabType: mockSetActiveTabType,
  setTabBarOrder: mockSetTabBarOrder,
  tabsByWorktree: {} as Record<string, { id: string }[]>,
  openFiles: [] as { id: string; worktreeId: string }[],
  browserTabsByWorktree: {} as Record<string, { id: string }[]>,
  tabBarOrderByWorktree: {} as Record<string, string[]>
}

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockState
  }
}))

vi.mock('@/components/tab-bar/reconcile-order', () => ({
  reconcileTabOrder: (
    _current: string[] | undefined,
    terminalIds: string[],
    editorIds: string[],
    browserIds: string[]
  ) => [...terminalIds, ...editorIds, ...browserIds]
}))

vi.mock('@/lib/telemetry', () => ({
  tuiAgentToAgentKind: (agent: string) => agent
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: runtimeMocks.getRuntimeEnvironmentIdForWorktree
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionTerminal: runtimeMocks.createWebRuntimeSessionTerminal,
  isWebRuntimeSessionActive: runtimeMocks.isWebRuntimeSessionActive
}))

import { launchAiVaultSessionInNewTab } from './launch-ai-vault-session'

describe('launchAiVaultSessionInNewTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runtimeMocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue(null)
    runtimeMocks.isWebRuntimeSessionActive.mockReturnValue(false)
    runtimeMocks.createWebRuntimeSessionTerminal.mockResolvedValue({ status: 'created' })
    mockState.tabsByWorktree = {}
    mockState.openFiles = []
    mockState.browserTabsByWorktree = {}
    mockState.tabBarOrderByWorktree = {}
    mockCreateTab.mockImplementation((worktreeId: string) => {
      const tab = { id: `tab-${(mockState.tabsByWorktree[worktreeId] ?? []).length + 1}` }
      mockState.tabsByWorktree[worktreeId] = [...(mockState.tabsByWorktree[worktreeId] ?? []), tab]
      return tab
    })
    mockCreateEmptySplitGroup.mockReturnValue('group-new')
  })

  it('creates a terminal in the requested tab group and queues the resume command', () => {
    const result = launchAiVaultSessionInNewTab({
      agent: 'claude',
      worktreeId: 'wt-1',
      targetGroupId: 'group-1',
      command: 'claude --resume session-1'
    })

    expect(mockCreateTab).toHaveBeenCalledWith('wt-1', 'group-1')
    expect(mockQueueTabStartupCommand).toHaveBeenCalledWith('tab-1', {
      command: 'claude --resume session-1',
      telemetry: {
        agent_kind: 'claude',
        launch_source: 'sidebar',
        request_kind: 'resume'
      }
    })
    expect(mockSetActiveTabType).toHaveBeenCalledWith('terminal')
    expect(mockSetTabBarOrder).toHaveBeenCalledWith('wt-1', ['tab-1'])
    expect(result).toEqual({ tabId: 'tab-1', groupId: 'group-1' })
  })

  it('queues configured resume startup details for agent history resumes', () => {
    launchAiVaultSessionInNewTab({
      agent: 'claude',
      worktreeId: 'wt-1',
      command: "claude '--dangerously-skip-permissions' '--effort' 'max' '--resume' 'session-1'",
      env: { ANTHROPIC_BASE_URL: 'https://claude.example.test' },
      envToDelete: ['CODEX_HOME'],
      launchConfig: {
        agentCommand: "claude '--dangerously-skip-permissions' '--effort' 'max'",
        agentArgs: '--dangerously-skip-permissions --effort max',
        agentEnv: { ANTHROPIC_BASE_URL: 'https://claude.example.test' }
      }
    })

    expect(mockQueueTabStartupCommand).toHaveBeenCalledWith('tab-1', {
      command: "claude '--dangerously-skip-permissions' '--effort' 'max' '--resume' 'session-1'",
      env: { ANTHROPIC_BASE_URL: 'https://claude.example.test' },
      envToDelete: ['CODEX_HOME'],
      launchConfig: {
        agentCommand: "claude '--dangerously-skip-permissions' '--effort' 'max'",
        agentArgs: '--dangerously-skip-permissions --effort max',
        agentEnv: { ANTHROPIC_BASE_URL: 'https://claude.example.test' }
      },
      launchAgent: 'claude',
      telemetry: {
        agent_kind: 'claude',
        launch_source: 'sidebar',
        request_kind: 'resume'
      }
    })
  })

  it('creates a split group before launching when a split direction is provided', () => {
    launchAiVaultSessionInNewTab({
      agent: 'codex',
      worktreeId: 'wt-1',
      targetGroupId: 'group-1',
      splitDirection: 'right',
      command: 'codex resume session-2'
    })

    expect(mockCreateEmptySplitGroup).toHaveBeenCalledWith('wt-1', 'group-1', 'right')
    expect(mockCreateTab).toHaveBeenCalledWith('wt-1', 'group-new')
  })

  it('creates runtime-hosted resume terminals through the paired host', async () => {
    runtimeMocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue('env-1')
    runtimeMocks.isWebRuntimeSessionActive.mockReturnValue(true)

    const result = launchAiVaultSessionInNewTab({
      agent: 'codex',
      worktreeId: 'wt-1',
      targetGroupId: 'group-1',
      command: "codex resume 'session-1'",
      env: { CODEX_PROFILE: 'runtime' },
      envToDelete: ['CODEX_HOME', 'ORCA_CODEX_HOME'],
      launchConfig: {
        agentCommand: 'codex',
        agentArgs: '',
        agentEnv: { CODEX_PROFILE: 'runtime' }
      },
      providerSession: { key: 'session_id', id: 'session-1' }
    })

    expect(result.tabId).toBeNull()
    expect(runtimeMocks.createWebRuntimeSessionTerminal).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      environmentId: 'env-1',
      targetGroupId: 'group-1',
      agentSessionKind: 'resume',
      launchAgent: 'codex',
      command: "codex resume 'session-1'",
      env: { CODEX_PROFILE: 'runtime' },
      envToDelete: ['CODEX_HOME', 'ORCA_CODEX_HOME'],
      launchConfig: {
        agentCommand: 'codex',
        agentArgs: '',
        agentEnv: { CODEX_PROFILE: 'runtime' }
      },
      providerSession: { key: 'session_id', id: 'session-1' },
      agentArgs: '',
      activate: true
    })
    expect(mockCreateTab).not.toHaveBeenCalled()
    expect(mockQueueTabStartupCommand).not.toHaveBeenCalled()

    if (result.tabId === null) {
      await expect(result.runtimeLaunch).resolves.toEqual({ status: 'created' })
    }
    expect(mockSetActiveTabType).toHaveBeenCalledWith('terminal')
  })
})
