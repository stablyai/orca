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
      focus: vi.fn(),
      modes: { bracketedPasteMode: true }
    }
  }
}

describe('sendTerminalQuickCommandToPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
      transport: { sendInput },
      onError: vi.fn()
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
      transport: { sendInput },
      onError: vi.fn()
    })

    expect(sent).toBe(false)
    expect(sendInput).toHaveBeenCalledWith('npm test', 'driving')
    expect(pane.terminal.focus).not.toHaveBeenCalled()
    expect(mocks.recordTerminalUserInputForLeaf).not.toHaveBeenCalled()
  })

  it('pastes multiline commands as one shell input before submitting', () => {
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
      transport: { sendInput },
      onError: vi.fn()
    })

    expect(sent).toBe(true)
    expect(sendInput).toHaveBeenCalledWith(
      '\x1b[200~cd packages\rbun run build\rcd ..\x1b[201~\r',
      'driving'
    )
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
      tabId: 'tab-1',
      transport: { sendInput },
      onError: vi.fn()
    })

    expect(sent).toBe(true)
    expect(sendInput).toHaveBeenCalledWith('\x1b[200~echo one\recho two\x1b[201~', 'driving')
    expect(pane.terminal.focus).toHaveBeenCalledOnce()
  })

  it.each(
    (
      [
        ['LF', '\n'],
        ['CRLF', '\r\n'],
        ['CR', '\r']
      ] as const
    ).flatMap(([lineEnding, newline]) =>
      [true, false].map((appendEnter) => ({ lineEnding, newline, appendEnter }))
    )
  )(
    'refuses $lineEnding multiline input before sending bytes without bracketed paste (appendEnter=$appendEnter)',
    ({ newline, appendEnter }) => {
      const sendInput = vi.fn(() => true)
      const onError = vi.fn()
      const pane = createPane()
      pane.terminal.modes.bracketedPasteMode = false
      expect(
        sendTerminalQuickCommandToPane({
          command: {
            id: 'script',
            label: 'Script',
            command: ['read answer', "printf '%s\\n' 'must execute'", ''].join(newline),
            appendEnter
          },
          pane,
          tabId: 'tab-1',
          transport: { sendInput },
          onError
        })
      ).toBe(false)
      expect(sendInput).not.toHaveBeenCalled()
      expect(onError).toHaveBeenCalledWith(
        'This shell cannot safely receive a multiline command here. Use a script file or a shell with bracketed paste.'
      )
      expect(pane.terminal.focus).not.toHaveBeenCalled()
      expect(mocks.recordTerminalUserInputForLeaf).not.toHaveBeenCalled()
    }
  )

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
      pane: { leafId: 'leaf-1', terminal: { focus, modes: { bracketedPasteMode: true } } },
      tabId: 'tab-1',
      transport: { sendInput },
      onError: vi.fn()
    })

    expect(sent).toBe(false)
    expect(sendInput).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
    expect(mocks.recordTerminalUserInputForLeaf).not.toHaveBeenCalled()
  })
})
