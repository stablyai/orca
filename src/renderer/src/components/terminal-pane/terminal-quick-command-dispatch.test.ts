import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  recordTerminalUserInputForLeaf: vi.fn()
}))

vi.mock('./terminal-input-activity', () => ({
  recordTerminalUserInputForLeaf: mocks.recordTerminalUserInputForLeaf
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
  })

  it('routes submitted commands through the typed transport and refocuses the terminal', async () => {
    const sendInput = vi.fn(() => true)
    const sendQuickCommand = vi.fn(async () => true)
    const pane = createPane()

    const sent = await sendTerminalQuickCommandToPane({
      command: {
        id: 'status',
        label: 'Status',
        command: 'git status',
        appendEnter: true
      },
      pane,
      tabId: 'tab-1',
      transport: { sendInput, sendQuickCommand }
    })

    expect(sent).toBe(true)
    expect(sendQuickCommand).toHaveBeenCalledWith('git status\r')
    expect(sendInput).not.toHaveBeenCalled()
    expect(pane.terminal.focus).toHaveBeenCalledOnce()
    expect(mocks.recordTerminalUserInputForLeaf).toHaveBeenCalledWith('tab-1', 'leaf-1')
  })

  it('refocuses immediately while a submitted command waits for the TUI barrier', async () => {
    let resolveSend!: (accepted: boolean) => void
    const sendQuickCommand = vi.fn(() => new Promise<boolean>((resolve) => (resolveSend = resolve)))
    const pane = createPane()
    const pending = sendTerminalQuickCommandToPane({
      command: {
        id: 'status',
        label: 'Status',
        command: 'git status',
        appendEnter: true
      },
      pane,
      tabId: 'tab-1',
      transport: { sendInput: vi.fn(() => true), sendQuickCommand }
    })

    expect(pane.terminal.focus).toHaveBeenCalledOnce()
    resolveSend(true)
    await expect(pending).resolves.toBe(true)
    expect(pane.terminal.focus).toHaveBeenCalledOnce()
  })

  it('does not focus the terminal when no connected transport accepts input', async () => {
    const sendInput = vi.fn(() => false)
    const pane = createPane()

    const sent = await sendTerminalQuickCommandToPane({
      command: {
        id: 'draft',
        label: 'Draft',
        command: 'npm test',
        appendEnter: false
      },
      pane,
      tabId: 'tab-1',
      transport: { sendInput }
    })

    expect(sent).toBe(false)
    expect(sendInput).toHaveBeenCalledWith('npm test')
    expect(pane.terminal.focus).not.toHaveBeenCalled()
    expect(mocks.recordTerminalUserInputForLeaf).not.toHaveBeenCalled()
  })

  it('flattens multiline commands with semicolons before sending', async () => {
    const sendInput = vi.fn(() => true)
    const sendQuickCommand = vi.fn(async () => true)
    const pane = createPane()
    const commandText = 'cd packages\nbun run build\ncd ..'

    const sent = await sendTerminalQuickCommandToPane({
      command: {
        id: 'build',
        label: 'Build',
        command: commandText,
        appendEnter: true
      },
      pane,
      tabId: 'tab-1',
      transport: { sendInput, sendQuickCommand }
    })

    expect(sent).toBe(true)
    expect(sendQuickCommand).toHaveBeenCalledWith('cd packages; bun run build; cd ..\r')
    expect(sendInput).not.toHaveBeenCalled()
    expect(pane.terminal.focus).toHaveBeenCalledOnce()
  })

  it('flattens multiline insert-only commands without submitting', async () => {
    const sendInput = vi.fn(() => true)
    const pane = createPane()
    const commandText = 'echo one\necho two'

    const sent = await sendTerminalQuickCommandToPane({
      command: {
        id: 'insert',
        label: 'Insert',
        command: commandText,
        appendEnter: false
      },
      pane,
      tabId: 'tab-1',
      transport: { sendInput }
    })

    expect(sent).toBe(true)
    expect(sendInput).toHaveBeenCalledWith('echo one; echo two')
    expect(pane.terminal.focus).toHaveBeenCalledOnce()
  })

  it('does not write agent prompt quick commands into the current pane', async () => {
    const sendInput = vi.fn(() => true)
    const focus = vi.fn()

    const sent = await sendTerminalQuickCommandToPane({
      command: {
        id: 'agent',
        label: 'Agent',
        action: 'agent-prompt',
        agent: 'codex',
        prompt: 'Review this'
      },
      pane: { leafId: 'leaf-1', terminal: { focus } },
      tabId: 'tab-1',
      transport: { sendInput }
    })

    expect(sent).toBe(false)
    expect(sendInput).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
    expect(mocks.recordTerminalUserInputForLeaf).not.toHaveBeenCalled()
  })
})
