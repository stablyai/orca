import { describe, expect, it, vi } from 'vitest'
import { sendTerminalQuickCommandToPane } from './terminal-quick-command-dispatch'

function createPane() {
  return {
    terminal: {
      focus: vi.fn()
    }
  }
}

describe('sendTerminalQuickCommandToPane', () => {
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
      transport: { sendInput }
    })

    expect(sent).toBe(true)
    expect(sendInput).toHaveBeenCalledWith('git status\r')
    expect(pane.terminal.focus).toHaveBeenCalledOnce()
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
      transport: { sendInput }
    })

    expect(sent).toBe(false)
    expect(sendInput).toHaveBeenCalledWith('npm test')
    expect(pane.terminal.focus).not.toHaveBeenCalled()
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
      transport: { sendInput }
    })

    expect(sent).toBe(true)
    expect(sendInput).toHaveBeenCalledWith('cd packages; bun run build; cd ..\r')
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
      transport: { sendInput }
    })

    expect(sent).toBe(true)
    expect(sendInput).toHaveBeenCalledWith('echo one; echo two')
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
      pane: { terminal: { focus } },
      transport: { sendInput }
    })

    expect(sent).toBe(false)
    expect(sendInput).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
  })
})
