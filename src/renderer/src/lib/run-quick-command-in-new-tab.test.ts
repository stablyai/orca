import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runQuickCommandInNewTab } from './run-quick-command-in-new-tab'

type MockStoreState = {
  createTab: ReturnType<typeof vi.fn>
  queueTabInitialCwd: ReturnType<typeof vi.fn>
  queueTabStartupCommand: ReturnType<typeof vi.fn>
  setActiveTabType: ReturnType<typeof vi.fn>
  setTabBarOrder: ReturnType<typeof vi.fn>
  setRecentQuickCommandForGroup: ReturnType<typeof vi.fn>
  tabsByWorktree: Record<string, { id: string }[]>
  unifiedTabsByWorktree: Record<
    string,
    { entityId: string; contentType: string; groupId: string }[]
  >
  activeGroupIdByWorktree: Record<string, string>
  openFiles: { id: string; worktreeId: string }[]
  browserTabsByWorktree: Record<string, { id: string }[]>
  tabBarOrderByWorktree: Record<string, string[]>
}

const mocks = vi.hoisted(() => ({
  launchAgentInNewTab: vi.fn(),
  requestBackgroundTerminalWorktreeMount: vi.fn(),
  createWebRuntimeSessionTerminal: vi.fn(),
  getRuntimeEnvironmentIdForWorktree: vi.fn(),
  isWebRuntimeSessionActive: vi.fn(),
  toastError: vi.fn()
}))

let mockState: MockStoreState

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockState
  }
}))

vi.mock('@/lib/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab: mocks.launchAgentInNewTab
}))

vi.mock('@/components/terminal/background-terminal-worktree-mount', () => ({
  requestBackgroundTerminalWorktreeMount: mocks.requestBackgroundTerminalWorktreeMount
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: mocks.getRuntimeEnvironmentIdForWorktree
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionTerminal: mocks.createWebRuntimeSessionTerminal,
  isWebRuntimeSessionActive: mocks.isWebRuntimeSessionActive
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

function createStoreState(): MockStoreState {
  return {
    createTab: vi.fn(() => ({ id: 'tab-new' })),
    queueTabInitialCwd: vi.fn(),
    queueTabStartupCommand: vi.fn(),
    setActiveTabType: vi.fn(),
    setTabBarOrder: vi.fn(),
    setRecentQuickCommandForGroup: vi.fn(),
    tabsByWorktree: { 'wt-1': [{ id: 'tab-existing' }, { id: 'tab-new' }] },
    unifiedTabsByWorktree: {
      'wt-1': [{ entityId: 'tab-new', contentType: 'terminal', groupId: 'group-1' }]
    },
    activeGroupIdByWorktree: { 'wt-1': 'group-1' },
    openFiles: [],
    browserTabsByWorktree: {},
    tabBarOrderByWorktree: {}
  }
}

describe('runQuickCommandInNewTab', () => {
  beforeEach(() => {
    mockState = createStoreState()
    mocks.launchAgentInNewTab.mockReset()
    mocks.requestBackgroundTerminalWorktreeMount.mockReset()
    mocks.createWebRuntimeSessionTerminal.mockReset()
    mocks.createWebRuntimeSessionTerminal.mockResolvedValue({ status: 'created' })
    mocks.getRuntimeEnvironmentIdForWorktree.mockReset()
    mocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue(null)
    mocks.isWebRuntimeSessionActive.mockReset()
    mocks.isWebRuntimeSessionActive.mockImplementation((value) => Boolean(value))
    mocks.toastError.mockReset()
  })

  it('flattens multiline quick commands before queuing', () => {
    const result = runQuickCommandInNewTab({
      command: {
        id: 'build',
        label: 'Build',
        action: 'terminal-command',
        command: 'cd packages\nbun run build\ncd ..',
        appendEnter: true
      },
      worktreeId: 'wt-1',
      groupId: 'group-1'
    })

    expect(result).toEqual({ tabId: 'tab-new' })
    expect(mockState.createTab).toHaveBeenCalledWith('wt-1', 'group-1', undefined, {
      quickCommandLabel: 'Build'
    })
    expect(mockState.queueTabStartupCommand).toHaveBeenCalledWith('tab-new', {
      command: 'cd packages; bun run build; cd ..'
    })
    expect(mockState.setRecentQuickCommandForGroup).toHaveBeenCalledWith('group-1', 'build')
  })

  it('records a host-qualified history id when provided', () => {
    runQuickCommandInNewTab({
      command: {
        id: 'build',
        label: 'Build',
        action: 'terminal-command',
        command: 'pnpm build',
        appendEnter: true
      },
      worktreeId: 'wt-1',
      groupId: 'group-1',
      historyId: 'runtime:server\0build'
    })

    expect(mockState.setRecentQuickCommandForGroup).toHaveBeenCalledWith(
      'group-1',
      'runtime:server\0build'
    )
  })

  it('keeps single-line quick commands unchanged', () => {
    runQuickCommandInNewTab({
      command: {
        id: 'status',
        label: 'Status',
        action: 'terminal-command',
        command: 'git status',
        appendEnter: true
      },
      worktreeId: 'wt-1',
      groupId: 'group-1'
    })

    expect(mockState.queueTabStartupCommand).toHaveBeenCalledWith('tab-new', {
      command: 'git status'
    })
  })

  it('runs terminal commands in a mounted background tab without changing the active view', () => {
    runQuickCommandInNewTab({
      command: {
        id: 'test',
        label: 'Test',
        action: 'terminal-command',
        command: 'pnpm test',
        appendEnter: true,
        openInBackground: true
      },
      worktreeId: 'wt-1',
      groupId: 'group-1'
    })

    expect(mockState.createTab).toHaveBeenCalledWith('wt-1', 'group-1', undefined, {
      quickCommandLabel: 'Test',
      activate: false
    })
    expect(mocks.requestBackgroundTerminalWorktreeMount).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabIds: ['tab-new']
    })
    expect(mockState.setActiveTabType).not.toHaveBeenCalled()
  })

  it('inherits the selected pane cwd for local, SSH, and folder-workspace terminal creation', () => {
    runQuickCommandInNewTab({
      command: {
        id: 'test',
        label: 'Test',
        command: 'pnpm test',
        appendEnter: true,
        openInBackground: true
      },
      worktreeId: 'folder:workspace',
      groupId: 'group-1',
      initialCwd: 'C:\\Users\\dev\\repo\\packages\\app'
    })

    expect(mockState.queueTabInitialCwd).toHaveBeenCalledWith(
      'tab-new',
      'C:\\Users\\dev\\repo\\packages\\app'
    )
  })

  it('routes background terminal commands and cwd through the paired host', async () => {
    mocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue('runtime-1')

    const result = runQuickCommandInNewTab({
      command: {
        id: 'test',
        label: 'Test',
        command: 'cd packages\npnpm test',
        appendEnter: false,
        openInBackground: true
      },
      worktreeId: 'wt-1',
      groupId: 'group-1',
      initialCwd: '/repo/packages/app'
    })

    expect(result).toBeNull()
    expect(mocks.createWebRuntimeSessionTerminal).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      environmentId: 'runtime-1',
      targetGroupId: 'group-1',
      command: 'cd packages; pnpm test',
      cwd: '/repo/packages/app',
      activate: false,
      selectWorktree: false
    })
    expect(mockState.createTab).not.toHaveBeenCalled()
    expect(mockState.queueTabStartupCommand).not.toHaveBeenCalled()
    await vi.waitFor(() =>
      expect(mockState.setRecentQuickCommandForGroup).toHaveBeenCalledWith('group-1', 'test')
    )
  })

  it('preserves foreground routing while a paired runtime session is active', () => {
    mocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue('runtime-1')

    const result = runQuickCommandInNewTab({
      command: {
        id: 'test',
        label: 'Test',
        command: 'pnpm test',
        appendEnter: true
      },
      worktreeId: 'wt-1',
      groupId: 'group-1'
    })

    expect(result).toEqual({ tabId: 'tab-new' })
    expect(mocks.getRuntimeEnvironmentIdForWorktree).not.toHaveBeenCalled()
    expect(mocks.createWebRuntimeSessionTerminal).not.toHaveBeenCalled()
    expect(mockState.createTab).toHaveBeenCalled()
  })

  it('reports paired background launch failures without recording history', async () => {
    mocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue('runtime-1')
    mocks.createWebRuntimeSessionTerminal.mockResolvedValue({
      status: 'failed',
      message: 'Host disconnected'
    })

    runQuickCommandInNewTab({
      command: {
        id: 'test',
        label: 'Test',
        command: 'pnpm test',
        appendEnter: true,
        openInBackground: true
      },
      worktreeId: 'wt-1',
      groupId: 'group-1'
    })

    await vi.waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Host disconnected'))
    expect(mockState.setRecentQuickCommandForGroup).not.toHaveBeenCalled()
  })

  it('reports unexpected paired background launch rejections without recording history', async () => {
    const error = new Error('Relay unavailable')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue('runtime-1')
    mocks.createWebRuntimeSessionTerminal.mockRejectedValue(error)

    runQuickCommandInNewTab({
      command: {
        id: 'test',
        label: 'Test',
        command: 'pnpm test',
        appendEnter: true,
        openInBackground: true
      },
      worktreeId: 'wt-1',
      groupId: 'group-1'
    })

    await vi.waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        'Could not run the Quick Command on the remote host.'
      )
    )
    expect(consoleError).toHaveBeenCalledWith('Quick Command remote launch failed', error)
    expect(mockState.setRecentQuickCommandForGroup).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('launches agent quick commands through the programmatic agent prompt path', () => {
    mocks.launchAgentInNewTab.mockReturnValue({ tabId: 'tab-agent' })
    mockState.unifiedTabsByWorktree['repo::worktree'] = [
      { entityId: 'tab-agent', contentType: 'terminal', groupId: 'group-1' }
    ]

    const result = runQuickCommandInNewTab({
      command: {
        id: 'agent-review',
        label: 'Review',
        action: 'agent-prompt',
        agent: 'codex',
        prompt: 'Review this diff'
      },
      worktreeId: 'repo::worktree',
      groupId: 'group-1'
    })

    expect(result).toEqual({ tabId: 'tab-agent' })
    expect(mocks.launchAgentInNewTab).toHaveBeenCalledWith({
      agent: 'codex',
      prompt: 'Review this diff',
      worktreeId: 'repo::worktree',
      groupId: 'group-1',
      launchSource: 'quick_command',
      quickCommandLabel: 'Review'
    })
    expect(mockState.queueTabStartupCommand).not.toHaveBeenCalled()
    expect(mockState.setRecentQuickCommandForGroup).toHaveBeenCalledWith('group-1', 'agent-review')
  })

  it('falls back to the active group when context-menu group resolution is missing', () => {
    mockState.activeGroupIdByWorktree['repo::worktree'] = 'active-group'
    mocks.launchAgentInNewTab.mockReturnValue({ tabId: 'tab-agent' })

    const result = runQuickCommandInNewTab({
      command: {
        id: 'agent-review',
        label: 'Review',
        action: 'agent-prompt',
        agent: 'codex',
        prompt: 'Review this diff'
      },
      worktreeId: 'repo::worktree',
      groupId: null
    })

    expect(result).toEqual({ tabId: 'tab-agent' })
    expect(mocks.launchAgentInNewTab).toHaveBeenCalledWith({
      agent: 'codex',
      prompt: 'Review this diff',
      worktreeId: 'repo::worktree',
      groupId: undefined,
      launchSource: 'quick_command',
      quickCommandLabel: 'Review'
    })
    expect(mockState.setRecentQuickCommandForGroup).toHaveBeenCalledWith(
      'active-group',
      'agent-review'
    )
  })

  it('runs agent prompts in a mounted background tab without activating it', () => {
    mocks.launchAgentInNewTab.mockReturnValue({ tabId: 'tab-agent' })
    mockState.unifiedTabsByWorktree['repo::worktree'] = [
      { entityId: 'tab-agent', contentType: 'terminal', groupId: 'group-1' }
    ]

    runQuickCommandInNewTab({
      command: {
        id: 'agent-review',
        label: 'Review',
        action: 'agent-prompt',
        agent: 'codex',
        prompt: 'Review this diff',
        openInBackground: true
      },
      worktreeId: 'repo::worktree',
      groupId: 'group-1',
      initialCwd: '/repo/packages/app'
    })

    expect(mocks.launchAgentInNewTab).toHaveBeenCalledWith({
      agent: 'codex',
      prompt: 'Review this diff',
      worktreeId: 'repo::worktree',
      groupId: 'group-1',
      initialCwd: '/repo/packages/app',
      activate: false,
      launchSource: 'quick_command',
      quickCommandLabel: 'Review'
    })
    expect(mocks.requestBackgroundTerminalWorktreeMount).toHaveBeenCalledWith({
      worktreeId: 'repo::worktree',
      tabIds: ['tab-agent']
    })
  })

  it('records paired background agent history after prompt delivery succeeds', async () => {
    mocks.launchAgentInNewTab.mockReturnValue({
      tabId: null,
      promptDeliveryResult: Promise.resolve({ delivered: true, failureNotified: false })
    })

    runQuickCommandInNewTab({
      command: {
        id: 'agent-review',
        label: 'Review',
        action: 'agent-prompt',
        agent: 'codex',
        prompt: 'Review this diff',
        openInBackground: true
      },
      worktreeId: 'repo::worktree',
      groupId: 'group-1'
    })

    await vi.waitFor(() =>
      expect(mockState.setRecentQuickCommandForGroup).toHaveBeenCalledWith(
        'group-1',
        'agent-review'
      )
    )
  })

  it('reports paired background agent prompt delivery failures', async () => {
    mocks.launchAgentInNewTab.mockReturnValue({
      tabId: null,
      promptDeliveryResult: Promise.resolve({ delivered: false, failureNotified: false })
    })

    runQuickCommandInNewTab({
      command: {
        id: 'agent-review',
        label: 'Review',
        action: 'agent-prompt',
        agent: 'codex',
        prompt: 'Review this diff',
        openInBackground: true
      },
      worktreeId: 'repo::worktree',
      groupId: 'group-1'
    })

    await vi.waitFor(() => expect(mocks.toastError).toHaveBeenCalledOnce())
    expect(mockState.setRecentQuickCommandForGroup).not.toHaveBeenCalled()
  })

  it('does not launch post-start-only agent quick commands', () => {
    const result = runQuickCommandInNewTab({
      command: {
        id: 'agent-aider',
        label: 'Aider',
        action: 'agent-prompt',
        agent: 'aider',
        prompt: 'Review this diff'
      },
      worktreeId: 'repo::worktree',
      groupId: 'group-1'
    })

    expect(result).toBeNull()
    expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
    expect(mockState.queueTabStartupCommand).not.toHaveBeenCalled()
  })
})
