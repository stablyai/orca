import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runQuickCommandInNewTab } from './run-quick-command-in-new-tab'

type MockStoreState = {
  createTab: ReturnType<typeof vi.fn>
  setActiveTabType: ReturnType<typeof vi.fn>
  setTabBarOrder: ReturnType<typeof vi.fn>
  setRecentQuickCommandForGroup: ReturnType<typeof vi.fn>
  tabsByWorktree: Record<string, { id: string }[]>
  unifiedTabsByWorktree: Record<
    string,
    { entityId: string; contentType: string; groupId: string }[]
  >
  activeGroupIdByWorktree: Record<string, string>
  openFiles: {
    id: string
    worktreeId: string
    filePath?: string
    relativePath?: string
    mode?: 'edit' | 'diff'
    isUntitled?: boolean
    csvPreviewOnly?: boolean
    checkRunDetails?: unknown
  }[]
  activeFileIdByWorktree: Record<string, string | null>
  worktreesByRepo: Record<string, { id: string; path: string }[]>
  folderWorkspaces: unknown[]
  floatingWorkspacePath: string | null
  browserTabsByWorktree: Record<string, { id: string }[]>
  tabBarOrderByWorktree: Record<string, string[]>
}

const mocks = vi.hoisted(() => ({
  launchAgentInNewTab: vi.fn(),
  toastMessage: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { message: mocks.toastMessage }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
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
    setActiveTabType: vi.fn(),
    setTabBarOrder: vi.fn(),
    setRecentQuickCommandForGroup: vi.fn(),
    tabsByWorktree: { 'wt-1': [{ id: 'tab-existing' }, { id: 'tab-new' }] },
    unifiedTabsByWorktree: {
      'wt-1': [{ entityId: 'tab-new', contentType: 'terminal', groupId: 'group-1' }]
    },
    activeGroupIdByWorktree: { 'wt-1': 'group-1' },
    openFiles: [],
    activeFileIdByWorktree: {},
    worktreesByRepo: {},
    folderWorkspaces: [],
    floatingWorkspacePath: null,
    browserTabsByWorktree: {},
    tabBarOrderByWorktree: {}
  }
}

describe('runQuickCommandInNewTab', () => {
  beforeEach(() => {
    mockState = createStoreState()
    mocks.launchAgentInNewTab.mockReset()
    mocks.toastMessage.mockReset()
  })

  it('appends the new terminal after editor and browser tabs in the stored tab order', () => {
    mockState.openFiles = [{ id: 'file-1', worktreeId: 'wt-1' }]
    mockState.browserTabsByWorktree = { 'wt-1': [{ id: 'browser-1' }] }
    mockState.tabBarOrderByWorktree = { 'wt-1': ['file-1', 'tab-existing'] }

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

    expect(mockState.setTabBarOrder).toHaveBeenCalledWith('wt-1', [
      'file-1',
      'tab-existing',
      'browser-1',
      'tab-new'
    ])
  })

  it('substitutes the active editor file into a new-tab command', () => {
    mockState.openFiles = [
      {
        id: '/repo/src/app.py',
        filePath: '/repo/src/app.py',
        relativePath: 'src/app.py',
        worktreeId: 'wt-1',
        mode: 'edit'
      }
    ]
    mockState.activeFileIdByWorktree = { 'wt-1': '/repo/src/app.py' }
    mockState.worktreesByRepo = { repo: [{ id: 'wt-1', path: '/repo' }] }

    const result = runQuickCommandInNewTab({
      command: {
        id: 'run',
        label: 'Run file',
        action: 'terminal-command',
        command: 'python "${file}"',
        appendEnter: true
      },
      worktreeId: 'wt-1',
      groupId: 'group-1'
    })

    expect(result).toEqual({ tabId: 'tab-new' })
    expect(mockState.createTab).toHaveBeenCalledWith('wt-1', 'group-1', undefined, {
      quickCommandLabel: 'Run file',
      pendingStartup: { command: 'python "/repo/src/app.py"' }
    })
  })

  it('flattens multiline commands after substituting the editor file', () => {
    mockState.openFiles = [
      {
        id: '/repo/src/app.py',
        filePath: '/repo/src/app.py',
        relativePath: 'src/app.py',
        worktreeId: 'wt-1',
        mode: 'edit'
      }
    ]
    mockState.activeFileIdByWorktree = { 'wt-1': '/repo/src/app.py' }
    mockState.worktreesByRepo = { repo: [{ id: 'wt-1', path: '/repo' }] }

    runQuickCommandInNewTab({
      command: {
        id: 'run',
        label: 'Run file',
        action: 'terminal-command',
        command: 'python "${file}"\necho done',
        appendEnter: true
      },
      worktreeId: 'wt-1',
      groupId: 'group-1'
    })

    expect(mockState.createTab).toHaveBeenCalledWith('wt-1', 'group-1', undefined, {
      quickCommandLabel: 'Run file',
      pendingStartup: { command: 'python "/repo/src/app.py"; echo done' }
    })
  })

  it('does not spawn a tab when a file placeholder cannot be resolved', () => {
    const result = runQuickCommandInNewTab({
      command: {
        id: 'run',
        label: 'Run file',
        action: 'terminal-command',
        command: 'python "${file}"',
        appendEnter: true
      },
      worktreeId: 'wt-1',
      groupId: 'group-1'
    })

    expect(result).toBeNull()
    expect(mockState.createTab).not.toHaveBeenCalled()
    expect(mocks.toastMessage).toHaveBeenCalledWith(
      'This command needs an editor file. Open a file in this workspace and try again.'
    )
  })
})
