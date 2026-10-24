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

  it('writes the formatted command to the PTY transport and refocuses the terminal', () => {
    const sendInput = vi.fn(() => true)
    const pane = createPane()

    const sent = sendTerminalQuickCommandToPane({
      command: {
        id: 'status',
        label: 'Status',
        command: 'git status',
        appendEnter: true
      },
      pane,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      transport: { sendInput }
    })

    expect(sent).toBe(true)
    expect(sendInput).toHaveBeenCalledWith('git status\r', 'driving')
    expect(pane.terminal.focus).toHaveBeenCalledOnce()
    expect(mocks.recordTerminalUserInputForLeaf).toHaveBeenCalledWith('tab-1', 'leaf-1')
  })

  it('does not focus the terminal when no connected transport accepts input', () => {
    const sendInput = vi.fn(() => false)
    const pane = createPane()

    const sent = sendTerminalQuickCommandToPane({
      command: {
        id: 'draft',
        label: 'Draft',
        command: 'npm test',
        appendEnter: false
      },
      pane,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      transport: { sendInput }
    })

    expect(sent).toBe(false)
    expect(sendInput).toHaveBeenCalledWith('npm test', 'driving')
    expect(pane.terminal.focus).not.toHaveBeenCalled()
    expect(mocks.recordTerminalUserInputForLeaf).not.toHaveBeenCalled()
  })

  it('flattens multiline commands with semicolons before sending', () => {
    const sendInput = vi.fn(() => true)
    const pane = createPane()
    const commandText = 'cd packages\nbun run build\ncd ..'

    const sent = sendTerminalQuickCommandToPane({
      command: {
        id: 'build',
        label: 'Build',
        command: commandText,
        appendEnter: true
      },
      pane,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      transport: { sendInput }
    })

    expect(sent).toBe(true)
    expect(sendInput).toHaveBeenCalledWith('cd packages; bun run build; cd ..\r', 'driving')
    expect(pane.terminal.focus).toHaveBeenCalledOnce()
  })

  it('flattens multiline insert-only commands without submitting', () => {
    const sendInput = vi.fn(() => true)
    const pane = createPane()
    const commandText = 'echo one\necho two'

    const sent = sendTerminalQuickCommandToPane({
      command: {
        id: 'insert',
        label: 'Insert',
        command: commandText,
        appendEnter: false
      },
      pane,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      transport: { sendInput }
    })

    expect(sent).toBe(true)
    expect(sendInput).toHaveBeenCalledWith('echo one; echo two', 'driving')
    expect(pane.terminal.focus).toHaveBeenCalledOnce()
  })

  it('does not write agent prompt quick commands into the current pane', () => {
    const sendInput = vi.fn(() => true)
    const focus = vi.fn()

    const sent = sendTerminalQuickCommandToPane({
      command: {
        id: 'agent',
        label: 'Agent',
        action: 'agent-prompt',
        agent: 'codex',
        prompt: 'Review this'
      },
      pane: { leafId: 'leaf-1', terminal: { focus } },
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      transport: { sendInput }
    })

    expect(sent).toBe(false)
    expect(sendInput).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
    expect(mocks.recordTerminalUserInputForLeaf).not.toHaveBeenCalled()
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
