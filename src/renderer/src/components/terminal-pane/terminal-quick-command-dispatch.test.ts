import { describe, expect, it, vi } from 'vitest'
import { sendTerminalQuickCommandToPane } from './terminal-quick-command-dispatch'

function createPane() {
  return {
    terminal: {
      focus: vi.fn(),
      modes: { bracketedPasteMode: true },
      options: { ignoreBracketedPasteMode: false },
      paste: vi.fn()
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
    expect(pane.terminal.paste).not.toHaveBeenCalled()
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
    expect(pane.terminal.paste).not.toHaveBeenCalled()
    expect(pane.terminal.focus).not.toHaveBeenCalled()
  })

  it('pastes multiline commands before appending enter', () => {
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
    expect(pane.terminal.paste).toHaveBeenCalledWith(commandText)
    expect(sendInput).toHaveBeenCalledWith('\r')
    expect(pane.terminal.focus).toHaveBeenCalledOnce()
  })

  it('pastes multiline insert-only commands without submitting', () => {
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
    expect(pane.terminal.paste).toHaveBeenCalledWith(commandText)
    expect(sendInput).not.toHaveBeenCalled()
    expect(pane.terminal.focus).toHaveBeenCalledOnce()
  })
})
