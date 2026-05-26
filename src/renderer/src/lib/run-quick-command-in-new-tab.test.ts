import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runQuickCommandInNewTab } from './run-quick-command-in-new-tab'

type MockStoreState = {
  createTab: ReturnType<typeof vi.fn>
  queueTabStartupCommand: ReturnType<typeof vi.fn>
  setActiveTabType: ReturnType<typeof vi.fn>
  setTabBarOrder: ReturnType<typeof vi.fn>
  setRecentQuickCommandForGroup: ReturnType<typeof vi.fn>
  tabsByWorktree: Record<string, { id: string }[]>
  openFiles: { id: string; worktreeId: string }[]
  browserTabsByWorktree: Record<string, { id: string }[]>
  tabBarOrderByWorktree: Record<string, string[]>
}

let mockState: MockStoreState

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockState
  }
}))

function createStoreState(): MockStoreState {
  const state: MockStoreState = {
    createTab: vi.fn(() => ({ id: 'tab-new' })),
    queueTabStartupCommand: vi.fn(),
    setActiveTabType: vi.fn(),
    setTabBarOrder: vi.fn(),
    setRecentQuickCommandForGroup: vi.fn(),
    tabsByWorktree: { 'wt-1': [{ id: 'tab-existing' }, { id: 'tab-new' }] },
    openFiles: [],
    browserTabsByWorktree: {},
    tabBarOrderByWorktree: {}
  }
  return state
}

describe('runQuickCommandInNewTab', () => {
  beforeEach(() => {
    mockState = createStoreState()
  })

  it('queues multiline quick commands for terminal-paste delivery', () => {
    const result = runQuickCommandInNewTab({
      command: {
        id: 'build',
        label: 'Build',
        command: 'cd packages\nbun run build\ncd ..',
        appendEnter: true
      },
      worktreeId: 'wt-1',
      groupId: 'group-1'
    })

    expect(result).toEqual({ tabId: 'tab-new' })
    expect(mockState.queueTabStartupCommand).toHaveBeenCalledWith('tab-new', {
      command: 'cd packages\nbun run build\ncd ..',
      delivery: 'terminal-paste'
    })
    expect(mockState.setRecentQuickCommandForGroup).toHaveBeenCalledWith('group-1', 'build')
  })

  it('keeps single-line quick commands on the standard startup path', () => {
    runQuickCommandInNewTab({
      command: {
        id: 'status',
        label: 'Status',
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
})
