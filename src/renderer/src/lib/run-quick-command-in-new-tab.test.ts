import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runQuickCommandInNewTab } from './run-quick-command-in-new-tab'

type MockUnifiedTab = {
  id?: string
  entityId: string
  contentType: string
  groupId: string
  quickCommandId?: string
}

type MockStoreState = {
  createTab: ReturnType<typeof vi.fn>
  queueTabStartupCommand: ReturnType<typeof vi.fn>
  setActiveTabType: ReturnType<typeof vi.fn>
  setTabBarOrder: ReturnType<typeof vi.fn>
  setRecentQuickCommandForGroup: ReturnType<typeof vi.fn>
  activateTab: ReturnType<typeof vi.fn>
  focusGroup: ReturnType<typeof vi.fn>
  tabsByWorktree: Record<string, { id: string }[]>
  unifiedTabsByWorktree: Record<string, MockUnifiedTab[]>
  ptyIdsByTabId: Record<string, string[]>
  activeGroupIdByWorktree: Record<string, string>
  openFiles: { id: string; worktreeId: string }[]
  browserTabsByWorktree: Record<string, { id: string }[]>
  tabBarOrderByWorktree: Record<string, string[]>
}

const mocks = vi.hoisted(() => ({
  launchAgentInNewTab: vi.fn()
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

function createStoreState(): MockStoreState {
  return {
    createTab: vi.fn(() => ({ id: 'tab-new' })),
    queueTabStartupCommand: vi.fn(),
    setActiveTabType: vi.fn(),
    setTabBarOrder: vi.fn(),
    setRecentQuickCommandForGroup: vi.fn(),
    activateTab: vi.fn(),
    focusGroup: vi.fn(),
    tabsByWorktree: { 'wt-1': [{ id: 'tab-existing' }, { id: 'tab-new' }] },
    unifiedTabsByWorktree: {
      'wt-1': [{ entityId: 'tab-new', contentType: 'terminal', groupId: 'group-1' }]
    },
    ptyIdsByTabId: {},
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
  })

  it('flattens multiline quick commands before queuing', async () => {
    const result = await runQuickCommandInNewTab({
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

  it('keeps single-line quick commands unchanged', async () => {
    await runQuickCommandInNewTab({
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

  it('does not stamp a quick-command id when reuse is off', async () => {
    await runQuickCommandInNewTab({
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

    expect(mockState.createTab).toHaveBeenCalledWith('wt-1', 'group-1', undefined, {
      quickCommandLabel: 'Status'
    })
  })

  it('launches agent quick commands through the programmatic agent prompt path', async () => {
    mocks.launchAgentInNewTab.mockReturnValue({ tabId: 'tab-agent' })
    mockState.unifiedTabsByWorktree['repo::worktree'] = [
      { entityId: 'tab-agent', contentType: 'terminal', groupId: 'group-1' }
    ]

    const result = await runQuickCommandInNewTab({
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

  it('falls back to the active group when context-menu group resolution is missing', async () => {
    mockState.activeGroupIdByWorktree['repo::worktree'] = 'active-group'
    mocks.launchAgentInNewTab.mockReturnValue({ tabId: 'tab-agent' })

    const result = await runQuickCommandInNewTab({
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

  it('does not launch post-start-only agent quick commands', async () => {
    const result = await runQuickCommandInNewTab({
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

describe('runQuickCommandInNewTab — tab reuse', () => {
  const originalWindow = globalThis.window
  let dispatchEvent: ReturnType<typeof vi.fn>
  let getForegroundProcess: ReturnType<typeof vi.fn>

  const reuseCommand = {
    id: 'dev',
    label: 'Dev',
    action: 'terminal-command' as const,
    command: 'npm run dev',
    appendEnter: true,
    reuseTab: true
  }

  beforeEach(() => {
    mockState = createStoreState()
    mocks.launchAgentInNewTab.mockReset()
    dispatchEvent = vi.fn()
    getForegroundProcess = vi.fn()
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      dispatchEvent,
      api: {
        ...(originalWindow as unknown as { api?: Record<string, unknown> })?.api,
        pty: { getForegroundProcess }
      }
    } as unknown as typeof window
  })

  afterEach(() => {
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  function seedExistingDevTab(): void {
    mockState.unifiedTabsByWorktree['wt-1'] = [
      {
        id: 'tab-dev',
        entityId: 'tab-dev',
        contentType: 'terminal',
        groupId: 'group-1',
        quickCommandId: 'dev'
      }
    ]
    mockState.ptyIdsByTabId = { 'tab-dev': ['pty-dev'] }
  }

  it('reuses the idle terminal and re-sends the command instead of opening a tab', async () => {
    seedExistingDevTab()
    getForegroundProcess.mockResolvedValue('zsh') // idle shell

    const result = await runQuickCommandInNewTab({
      command: reuseCommand,
      worktreeId: 'wt-1',
      groupId: 'group-1'
    })

    expect(result).toEqual({ tabId: 'tab-dev' })
    expect(mockState.createTab).not.toHaveBeenCalled()
    expect(mockState.activateTab).toHaveBeenCalledWith('tab-dev')
    expect(mockState.focusGroup).toHaveBeenCalledWith('wt-1', 'group-1')
    expect(mockState.setActiveTabType).toHaveBeenCalledWith('terminal')
    expect(dispatchEvent).toHaveBeenCalledTimes(1)
    const event = dispatchEvent.mock.calls[0][0] as CustomEvent
    expect(event.type).toBe('orca-run-terminal-command')
    expect(event.detail).toEqual({ tabId: 'tab-dev', ptyId: 'pty-dev', input: 'npm run dev\r' })
    expect(mockState.setRecentQuickCommandForGroup).toHaveBeenCalledWith('group-1', 'dev')
  })

  it('forces Enter even when the command has appendEnter off', async () => {
    seedExistingDevTab()
    getForegroundProcess.mockResolvedValue('bash')

    await runQuickCommandInNewTab({
      command: { ...reuseCommand, appendEnter: false },
      worktreeId: 'wt-1',
      groupId: 'group-1'
    })

    const event = dispatchEvent.mock.calls[0][0] as CustomEvent
    expect(event.detail).toEqual({ tabId: 'tab-dev', ptyId: 'pty-dev', input: 'npm run dev\r' })
  })

  it('opens a new tab when the foreground-process probe rejects', async () => {
    seedExistingDevTab()
    getForegroundProcess.mockRejectedValue(new Error('ipc unavailable'))

    const result = await runQuickCommandInNewTab({
      command: reuseCommand,
      worktreeId: 'wt-1',
      groupId: 'group-1'
    })

    expect(result).toEqual({ tabId: 'tab-new' })
    expect(mockState.createTab).toHaveBeenCalledWith('wt-1', 'group-1', undefined, {
      quickCommandLabel: 'Dev',
      quickCommandId: 'dev'
    })
    expect(dispatchEvent).not.toHaveBeenCalled()
  })

  it('opens a new stamped tab when the existing terminal is busy', async () => {
    seedExistingDevTab()
    getForegroundProcess.mockResolvedValue('node') // foreground process running

    const result = await runQuickCommandInNewTab({
      command: reuseCommand,
      worktreeId: 'wt-1',
      groupId: 'group-1'
    })

    expect(result).toEqual({ tabId: 'tab-new' })
    expect(mockState.createTab).toHaveBeenCalledWith('wt-1', 'group-1', undefined, {
      quickCommandLabel: 'Dev',
      quickCommandId: 'dev'
    })
    expect(dispatchEvent).not.toHaveBeenCalled()
  })

  it('opens a new tab when the existing terminal shell is dead', async () => {
    seedExistingDevTab()
    getForegroundProcess.mockResolvedValue(null) // dead shell / web runtime

    const result = await runQuickCommandInNewTab({
      command: reuseCommand,
      worktreeId: 'wt-1',
      groupId: 'group-1'
    })

    expect(result).toEqual({ tabId: 'tab-new' })
    expect(mockState.createTab).toHaveBeenCalled()
    expect(dispatchEvent).not.toHaveBeenCalled()
  })

  it('opens a new stamped tab when no prior terminal exists for the command', async () => {
    const result = await runQuickCommandInNewTab({
      command: reuseCommand,
      worktreeId: 'wt-1',
      groupId: 'group-1'
    })

    expect(result).toEqual({ tabId: 'tab-new' })
    expect(getForegroundProcess).not.toHaveBeenCalled()
    expect(mockState.createTab).toHaveBeenCalledWith('wt-1', 'group-1', undefined, {
      quickCommandLabel: 'Dev',
      quickCommandId: 'dev'
    })
  })

  it('prefers an idle terminal over a busy one when several exist', async () => {
    mockState.unifiedTabsByWorktree['wt-1'] = [
      {
        id: 'tab-busy',
        entityId: 'tab-busy',
        contentType: 'terminal',
        groupId: 'group-1',
        quickCommandId: 'dev'
      },
      {
        id: 'tab-idle',
        entityId: 'tab-idle',
        contentType: 'terminal',
        groupId: 'group-1',
        quickCommandId: 'dev'
      }
    ]
    mockState.ptyIdsByTabId = { 'tab-busy': ['pty-busy'], 'tab-idle': ['pty-idle'] }
    getForegroundProcess.mockImplementation(async (ptyId: string) =>
      ptyId === 'pty-busy' ? 'node' : 'zsh'
    )

    const result = await runQuickCommandInNewTab({
      command: reuseCommand,
      worktreeId: 'wt-1',
      groupId: 'group-1'
    })

    expect(result).toEqual({ tabId: 'tab-idle' })
    expect(mockState.activateTab).toHaveBeenCalledWith('tab-idle')
    expect(mockState.createTab).not.toHaveBeenCalled()
  })
})
