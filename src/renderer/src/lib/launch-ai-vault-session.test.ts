import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockCreateTab = vi.fn()
const mockCreateEmptySplitGroup = vi.fn()
const mockCloseEmptyGroup = vi.fn()
function queuedStartups() {
  return mockCreateTab.mock.calls.flatMap((call) => call[3]?.pendingStartup ?? [])
}
const mockSetActiveTabType = vi.fn()
const mockSetTabBarOrder = vi.fn()
const runtimeMocks = vi.hoisted(() => ({
  createWebRuntimeSessionTerminal: vi.fn(),
  runtimeEnvironmentIdOrLocalUnlessTwin: vi.fn<() => string | null>(() => null),
  isWebRuntimeSessionActive: vi.fn(() => false)
}))

const mockState = {
  createTab: mockCreateTab,
  createEmptySplitGroup: mockCreateEmptySplitGroup,
  closeEmptyGroup: mockCloseEmptyGroup,
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
  runtimeEnvironmentIdOrLocalUnlessTwin: runtimeMocks.runtimeEnvironmentIdOrLocalUnlessTwin
}))

vi.mock('@/runtime/web-runtime-terminal-creation', () => ({
  createWebRuntimeSessionTerminal: runtimeMocks.createWebRuntimeSessionTerminal
}))
vi.mock('@/runtime/web-runtime-session-environment', () => ({
  isWebRuntimeSessionActive: runtimeMocks.isWebRuntimeSessionActive
}))

import { launchAiVaultSessionInNewTab } from './launch-ai-vault-session'

describe('launchAiVaultSessionInNewTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runtimeMocks.runtimeEnvironmentIdOrLocalUnlessTwin.mockReturnValue(null)
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

  it('creates runtime-hosted resume terminals through the paired host', async () => {
    runtimeMocks.runtimeEnvironmentIdOrLocalUnlessTwin.mockReturnValue('env-1')
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
    expect(runtimeMocks.createWebRuntimeSessionTerminal).toHaveBeenCalledWith(
      {
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
      },
      { notifyFailure: false }
    )
    expect(mockCreateTab).not.toHaveBeenCalled()
    expect(queuedStartups()).toEqual([])

    if (result.tabId === null) {
      await expect(result.runtimeLaunch).resolves.toEqual({ status: 'created' })
    }
    expect(mockSetActiveTabType).toHaveBeenCalledExactlyOnceWith('terminal', 'wt-1')
  })

  // #22791: a drop on a pane edge in a paired-runtime worktree opened a tab instead of a split.
  it('splits the pane before a runtime-hosted resume and targets the new group', async () => {
    runtimeMocks.runtimeEnvironmentIdOrLocalUnlessTwin.mockReturnValue('env-1')
    runtimeMocks.isWebRuntimeSessionActive.mockReturnValue(true)

    const result = launchAiVaultSessionInNewTab({
      agent: 'codex',
      worktreeId: 'wt-1',
      targetGroupId: 'group-1',
      splitDirection: 'right',
      command: 'codex resume session-2'
    })

    expect(mockCreateEmptySplitGroup).toHaveBeenCalledWith('wt-1', 'group-1', 'right')
    expect(runtimeMocks.createWebRuntimeSessionTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ targetGroupId: 'group-new' }),
      { notifyFailure: false }
    )
    if (result.tabId === null) {
      await result.runtimeLaunch
    }
    expect(mockCloseEmptyGroup).not.toHaveBeenCalled()
  })

  it('removes the still-empty split group when the runtime create does not succeed', async () => {
    runtimeMocks.runtimeEnvironmentIdOrLocalUnlessTwin.mockReturnValue('env-1')
    runtimeMocks.isWebRuntimeSessionActive.mockReturnValue(true)
    runtimeMocks.createWebRuntimeSessionTerminal.mockResolvedValue({
      status: 'failed',
      message: 'refused'
    })

    const result = launchAiVaultSessionInNewTab({
      agent: 'codex',
      worktreeId: 'wt-1',
      targetGroupId: 'group-1',
      splitDirection: 'right',
      command: 'codex resume session-2'
    })
    if (result.tabId === null) {
      await result.runtimeLaunch
    }

    expect(mockCloseEmptyGroup).toHaveBeenCalledWith('wt-1', 'group-new')
  })
})
