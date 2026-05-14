import { describe, expect, it, vi } from 'vitest'
import { sendTerminalQuickCommandToPane } from './terminal-quick-command-dispatch'

describe('sendTerminalQuickCommandToPane', () => {
  it('writes the formatted command to the PTY transport and refocuses the terminal', () => {
    const sendInput = vi.fn(() => true)
    const focus = vi.fn()

    const sent = sendTerminalQuickCommandToPane({
      command: {
        id: 'status',
        label: 'Status',
        command: 'git status',
        appendEnter: true
      },
      pane: { terminal: { focus } },
      transport: { sendInput }
    })

    expect(sent).toBe(true)
    expect(sendInput).toHaveBeenCalledWith('git status\r')
    expect(focus).toHaveBeenCalledOnce()
  })

  it('does not focus the terminal when no connected transport accepts input', () => {
    const sendInput = vi.fn(() => false)
    const focus = vi.fn()

    const sent = sendTerminalQuickCommandToPane({
      command: {
        id: 'draft',
        label: 'Draft',
        command: 'npm test',
        appendEnter: false
      },
      pane: { terminal: { focus } },
      transport: { sendInput }
    })

    expect(sent).toBe(false)
    expect(sendInput).toHaveBeenCalledWith('npm test')
    expect(focus).not.toHaveBeenCalled()
  })
})
