import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  closeEmptyGroup: vi.fn(),
  closeTab: vi.fn(),
  createTab: vi.fn(),
  createEmptySplitGroup: vi.fn(),
  getRuntimeEnvironmentIdForWorktree: vi.fn(),
  launchAgentInNewTab: vi.fn(),
  setTabCustomLabel: vi.fn(),
  setTabSideQuestSession: vi.fn(),
  setTabViewMode: vi.fn(),
  state: {
    groupsByWorktree: {} as Record<string, { id: string }[]>,
    settings: { experimentalNativeChat: true },
    unifiedTabsByWorktree: {} as Record<string, unknown[]>
  }
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mocks.state }
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: mocks.getRuntimeEnvironmentIdForWorktree
}))
vi.mock('@/runtime/web-runtime-session', () => ({
  isWebRuntimeSessionActive: (environmentId: string | null) => Boolean(environmentId)
}))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab: mocks.launchAgentInNewTab
}))

import { launchSideQuest } from './launch-side-quest'

describe('launchSideQuest', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(mocks.state, {
      closeEmptyGroup: mocks.closeEmptyGroup,
      closeTab: mocks.closeTab,
      createTab: mocks.createTab,
      createEmptySplitGroup: mocks.createEmptySplitGroup,
      setTabCustomLabel: mocks.setTabCustomLabel,
      setTabSideQuestSession: mocks.setTabSideQuestSession,
      setTabViewMode: mocks.setTabViewMode,
      groupsByWorktree: { worktree: [{ id: 'source-group' }] },
      settings: { experimentalNativeChat: true },
      unifiedTabsByWorktree: {}
    })
    Object.assign(mocks.state, { allWorktrees: undefined, repos: [] })
    mocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue(null)
    mocks.createEmptySplitGroup.mockReturnValue('side-group')
  })

  it('creates a right split and opens a read-only Codex tab in native chat', () => {
    const beforeOpenChat = vi.fn()
    mocks.launchAgentInNewTab.mockReturnValue({ tabId: 'terminal-tab' })
    mocks.state.unifiedTabsByWorktree = {
      worktree: [{ id: 'unified-tab', entityId: 'terminal-tab', contentType: 'terminal' }]
    }

    expect(
      launchSideQuest({
        worktreeId: 'worktree',
        sourceGroupId: 'source-group',
        agent: 'codex',
        beforeOpenChat
      })
    ).toEqual({ status: 'started', groupId: 'side-group', terminalTabId: 'terminal-tab' })
    expect(mocks.createEmptySplitGroup).toHaveBeenCalledWith('worktree', 'source-group', 'right')
    expect(mocks.launchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'codex',
        agentArgs: '--sandbox read-only --ask-for-approval never -c model_reasoning_effort=low',
        groupId: 'side-group',
        ignoreConfiguredAgentCommand: true,
        quickCommandLabel: 'Side Quest'
      })
    )
    expect(mocks.setTabViewMode).toHaveBeenCalledWith('unified-tab', 'chat')
    expect(mocks.setTabCustomLabel).toHaveBeenCalledWith('unified-tab', 'Side Quest')
    expect(beforeOpenChat).toHaveBeenCalledWith('terminal-tab', 'terminal')
    expect(beforeOpenChat.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setTabViewMode.mock.invocationCallOrder[0]
    )
  })

  it('does not create a local split for a host-owned runtime tab', () => {
    mocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue('remote-environment')

    expect(
      launchSideQuest({ worktreeId: 'worktree', sourceGroupId: 'source-group', agent: 'claude' })
    ).toEqual({ status: 'runtime-unsupported' })
    expect(mocks.createEmptySplitGroup).not.toHaveBeenCalled()
  })

  it('opens a local Codex Side Quest on the provider without launching a terminal agent', async () => {
    const create = vi.fn().mockResolvedValue({ providerThreadId: 'thread-1' })
    vi.stubGlobal('window', { api: { sideQuest: { create } } })
    Object.assign(mocks.state, {
      allWorktrees: () => [{ id: 'worktree', repoId: 'repo', path: '/repo' }],
      repos: [{ id: 'repo', connectionId: null }],
      tabsByWorktree: { worktree: [{ id: 'provider-tab' }] }
    })
    mocks.setTabSideQuestSession.mockImplementation((_tabId, session) => {
      const state = mocks.state as unknown as { tabsByWorktree: Record<string, unknown[]> }
      state.tabsByWorktree = {
        worktree: [{ id: 'provider-tab', sideQuestSession: session }]
      }
    })
    mocks.createTab.mockReturnValue({ id: 'provider-tab', startupCwd: undefined })
    mocks.state.unifiedTabsByWorktree = {
      worktree: [{ id: 'unified-tab', entityId: 'provider-tab', contentType: 'terminal' }]
    }

    expect(
      launchSideQuest({ worktreeId: 'worktree', sourceGroupId: 'source-group', agent: 'codex' })
    ).toEqual({ status: 'started', groupId: 'side-group', terminalTabId: 'provider-tab' })
    expect(mocks.createTab).toHaveBeenCalledWith('worktree', 'side-group', undefined, {
      launchAgent: 'codex',
      quickCommandLabel: 'Side Quest',
      viewMode: 'chat'
    })
    expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledWith({ cwd: '/repo' })
    await vi.waitFor(() =>
      expect(mocks.setTabSideQuestSession).toHaveBeenLastCalledWith(
        'provider-tab',
        expect.objectContaining({ providerThreadId: 'thread-1', status: 'ready' })
      )
    )
  })

  it('collapses the empty split when the agent launch fails', () => {
    mocks.launchAgentInNewTab.mockReturnValue(null)

    expect(
      launchSideQuest({ worktreeId: 'worktree', sourceGroupId: 'source-group', agent: 'claude' })
    ).toEqual({ status: 'failed' })
    expect(mocks.closeEmptyGroup).toHaveBeenCalledWith('worktree', 'side-group')
  })

  it('closes a partially-created terminal when unified tab registration fails', () => {
    mocks.launchAgentInNewTab.mockReturnValue({ tabId: 'terminal-tab' })

    expect(
      launchSideQuest({ worktreeId: 'worktree', sourceGroupId: 'source-group', agent: 'claude' })
    ).toEqual({ status: 'failed' })
    expect(mocks.closeTab).toHaveBeenCalledWith('terminal-tab')
    expect(mocks.closeEmptyGroup).toHaveBeenCalledWith('worktree', 'side-group')
  })

  it('requires native chat and a real source group before mutating layout', () => {
    mocks.state.settings.experimentalNativeChat = false
    expect(
      launchSideQuest({ worktreeId: 'worktree', sourceGroupId: 'source-group', agent: 'codex' })
    ).toEqual({ status: 'feature-disabled' })

    mocks.state.settings.experimentalNativeChat = true
    mocks.state.groupsByWorktree = { worktree: [] }
    expect(
      launchSideQuest({ worktreeId: 'worktree', sourceGroupId: 'missing', agent: 'codex' })
    ).toEqual({ status: 'missing-source-group' })
    expect(mocks.createEmptySplitGroup).not.toHaveBeenCalled()
  })
})
