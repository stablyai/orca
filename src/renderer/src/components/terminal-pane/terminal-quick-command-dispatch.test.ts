import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  recordTerminalUserInputForLeaf: vi.fn(),
  toastMessage: vi.fn()
}))

vi.mock('./terminal-input-activity', () => ({
  recordTerminalUserInputForLeaf: mocks.recordTerminalUserInputForLeaf
}))

vi.mock('sonner', () => ({
  toast: { message: mocks.toastMessage }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

type DispatchStoreState = {
  openFiles: {
    id: string
    filePath: string
    relativePath: string
    worktreeId: string
    mode: 'edit' | 'diff'
    isUntitled?: boolean
    csvPreviewOnly?: boolean
  }[]
  activeFileIdByWorktree: Record<string, string | null>
  worktreesByRepo: Record<string, { id: string; path: string }[]>
  folderWorkspaces: unknown[]
  floatingWorkspacePath: string | null
}

const storeState = vi.hoisted(() => {
  const current: DispatchStoreState = {
    openFiles: [],
    activeFileIdByWorktree: {},
    worktreesByRepo: {},
    folderWorkspaces: [],
    floatingWorkspacePath: null
  }
  return { current }
})

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => storeState.current
  }
}))

import { sendTerminalQuickCommandToPane } from './terminal-quick-command-dispatch'

function createPane() {
  return {
    leafId: 'leaf-1',
    terminal: {
      focus: vi.fn()
    }
  }
}

describe('sendTerminalQuickCommandToPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeState.current = {
      openFiles: [],
      activeFileIdByWorktree: {},
      worktreesByRepo: {},
      folderWorkspaces: [],
      floatingWorkspacePath: null
    }
  })

  it('substitutes the active editor file before writing to the pane', () => {
    storeState.current.openFiles = [
      {
        id: '/repo/src/app.py',
        filePath: '/repo/src/app.py',
        relativePath: 'src/app.py',
        worktreeId: 'wt-1',
        mode: 'edit'
      }
    ]
    storeState.current.activeFileIdByWorktree = { 'wt-1': '/repo/src/app.py' }
    storeState.current.worktreesByRepo = { repo: [{ id: 'wt-1', path: '/repo' }] }

    const sendInput = vi.fn(() => true)
    const pane = createPane()
    const sent = sendTerminalQuickCommandToPane({
      command: {
        id: 'run',
        label: 'Run file',
        command: 'python "${file}"',
        appendEnter: true
      },
      pane,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      transport: { sendInput }
    })

    expect(sent).toBe(true)
    expect(sendInput).toHaveBeenCalledWith('python "/repo/src/app.py"\r', 'driving')
  })

  it('does not send when a file token cannot be resolved', () => {
    const sendInput = vi.fn(() => true)
    const pane = createPane()
    const sent = sendTerminalQuickCommandToPane({
      command: {
        id: 'run',
        label: 'Run file',
        command: 'python "${file}"',
        appendEnter: true
      },
      pane,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      transport: { sendInput }
    })

    expect(sent).toBe(false)
    expect(sendInput).not.toHaveBeenCalled()
    expect(pane.terminal.focus).not.toHaveBeenCalled()
    expect(mocks.toastMessage).toHaveBeenCalledWith(
      'This command needs an editor file. Open a file in this workspace and try again.'
    )
  })
})
