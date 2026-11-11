import { afterEach, describe, expect, it } from 'vitest'
import {
  captureWakeProcessHint,
  cursorBelowLastText,
  detectForegroundCommand,
  dismissWakeProcessHint,
  endsAtShellPrompt,
  getWakeCaptureTime,
  getWakeProcessHint,
  historyEndRow,
  wakeHintForPane,
  readTerminalTail,
  resetWakeProcessCapture,
  resetWakeProcessHintsForTests
} from './cloud-wake-process-hints'

afterEach(() => resetWakeProcessHintsForTests())

describe('detectForegroundCommand', () => {
  it('finds a dev server still running at the end of the scrollback', () => {
    expect(
      detectForegroundCommand([
        'ubuntu@sbx:~/project$ ls',
        'README.md',
        'ubuntu@sbx:~/project$ python3 -m http.server 8000',
        'Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...',
        ''
      ])
    ).toEqual({ command: 'python3 -m http.server 8000' })
  })

  it('returns null for a shell idle at a prompt', () => {
    expect(detectForegroundCommand(['$ npm test', 'ok', 'ubuntu@sbx:~/project$ '])).toBeNull()
    expect(detectForegroundCommand(['$ npm test', 'ok', '$ git st'])).toBeNull()
  })

  // JA-15: Claude's input placeholder was offered as `Rerun Try "create a util logging.py that..."`.
  it('never offers an agent TUI input line as a command', () => {
    const claudeInputBox = [
      'ubuntu@sbx:~/project$ claude',
      '╭───────────────────────────────────────────────╮',
      '│ ✻ Welcome to Claude Code!                     │',
      '╰───────────────────────────────────────────────╯',
      '────────────────────────────────────────────────',
      '> Try "create a util logging.py that..."',
      '────────────────────────────────────────────────',
      '  ? for shortcuts'
    ]
    expect(detectForegroundCommand(claudeInputBox)).toBeNull()
    // Without the frame: a bare "> " or "› " row is TUI input, and the launch line is an agent.
    expect(
      detectForegroundCommand(['$ codex', '› Ask Codex to do anything', '  ⏎ send'])
    ).toBeNull()
    expect(detectForegroundCommand(['> Try "fix lint"', '  ? for shortcuts'])).toBeNull()
    expect(detectForegroundCommand(['$ claude', 'Thinking…'])).toBeNull()
  })

  it('still reads fish-style "~>" prompts', () => {
    expect(detectForegroundCommand(['neil@sbx ~/app> pnpm dev', 'ready'])).toEqual({
      command: 'pnpm dev'
    })
  })

  // WAKE-RERUN (cut 68321452c97c): `sleep 900` prints nothing, so its prompt line is the last text.
  it('a silent command still running (cursor below its prompt line) is offered', () => {
    const tail = ['ubuntu@ik-wake:~/orca/workspaces/Hello-World/ik-wake$ sleep 900', '']
    expect(detectForegroundCommand(tail, { cursorBelowText: true })).toEqual({
      command: 'sleep 900'
    })
    expect(wakeHintForPane(tail, { cursorBelowText: true })).toEqual({ command: 'sleep 900' })
  })

  it('a half-typed command (cursor still on the prompt line) offers nothing', () => {
    const tail = ['ubuntu@sbx:~/project$ git st']
    expect(detectForegroundCommand(tail, { cursorBelowText: false })).toBeNull()
    expect(detectForegroundCommand(tail)).toBeNull()
    expect(detectForegroundCommand(['ubuntu@sbx:~$ '], { cursorBelowText: true })).toBeNull()
  })

  it('a finished silent command (`true`, then a fresh prompt) offers nothing', () => {
    const tail = ['ubuntu@sbx:~/project$ true', 'ubuntu@sbx:~/project$ ']
    expect(detectForegroundCommand(tail, { cursorBelowText: false })).toBeNull()
    // Even read with the cursor below, the last text is a bare prompt: nothing was running.
    expect(detectForegroundCommand(tail, { cursorBelowText: true })).toBeNull()
  })

  it('a silent agent launch or launch script is still never offered', () => {
    expect(detectForegroundCommand(['$ claude'], { cursorBelowText: true })).toBeNull()
    expect(
      detectForegroundCommand(['$ . /tmp/orca-launch-3f9a.sh'], { cursorBelowText: true })
    ).toBeNull()
  })

  it('returns null when no prompt line is readable', () => {
    expect(detectForegroundCommand(['compiling…', 'done'])).toBeNull()
    expect(detectForegroundCommand([])).toBeNull()
  })
})

// JA-15 P2 (RA-WAKE P3): a Claude pane offered `Rerun Try "create a util logging.py that..."`.
describe('wakeHintForPane', () => {
  const claudeAtInput = [
    'ubuntu@sbx:~/project$ . /tmp/orca-launch-3f9a.sh',
    '────────────────────────────────────────────────',
    '> Try "create a util logging.py that..."',
    '────────────────────────────────────────────────',
    '  ? for shortcuts'
  ]

  it('a Claude pane offers Restart Claude, never its input placeholder or launch script', () => {
    expect(wakeHintForPane(claudeAtInput, { agentType: 'claude' })).toEqual({
      restartAgent: 'claude'
    })
  })

  it('without an agent row, the same TUI tail offers nothing', () => {
    expect(wakeHintForPane(claudeAtInput)).toBeNull()
  })

  it("never offers Orca's self-deleting launch script as a command", () => {
    expect(wakeHintForPane(['$ . /tmp/orca-launch-3f9a.sh', 'Starting…'])).toBeNull()
  })

  it('a shell pane keeps Rerun with its real command, even with a leftover agent row', () => {
    const devServer = ['$ claude', 'bye', '$ pnpm dev', '  ready on http://localhost:3000']
    expect(wakeHintForPane(devServer, { agentType: 'claude' })).toEqual({ command: 'pnpm dev' })
  })

  it('an agent row on a pane idle at its shell prompt offers nothing', () => {
    expect(
      wakeHintForPane(['$ claude', 'bye', 'ubuntu@sbx:~$ '], { agentType: 'claude' })
    ).toBeNull()
  })

  it('other agents get no Restart from this strip', () => {
    expect(wakeHintForPane(claudeAtInput, { agentType: 'gemini' })).toBeNull()
  })
})

describe('wake process hints', () => {
  const running = ['❯ pnpm dev', '  ready on http://localhost:3000']

  it('captures once per sleep: a later look (the fresh prompt after wake) does not overwrite it', () => {
    captureWakeProcessHint('leaf-1', running)
    captureWakeProcessHint('leaf-1', ['$ '])
    expect(getWakeProcessHint('leaf-1')).toEqual({ command: 'pnpm dev' })
  })

  it('only panes that had a process get a hint', () => {
    captureWakeProcessHint('leaf-busy', running)
    captureWakeProcessHint('leaf-idle', ['$ '])
    expect(getWakeProcessHint('leaf-busy')).not.toBeNull()
    expect(getWakeProcessHint('leaf-idle')).toBeNull()
  })

  it('a full-screen (alternate-screen) app gets no hint, even if its tail looks like a command', () => {
    captureWakeProcessHint('leaf-vim', running, { alternateScreen: true })
    expect(getWakeProcessHint('leaf-vim')).toBeNull()
  })

  it('dismiss clears it; the next sleep captures again', () => {
    captureWakeProcessHint('leaf-1', running)
    dismissWakeProcessHint('leaf-1')
    expect(getWakeProcessHint('leaf-1')).toBeNull()
    resetWakeProcessCapture(['leaf-1'])
    captureWakeProcessHint('leaf-1', running)
    expect(getWakeProcessHint('leaf-1')).toEqual({ command: 'pnpm dev' })
  })

  it('finds where the history ends on screen, or null when it fills the pane', () => {
    const screen = (lines: string[], rows: number) => ({
      rows,
      buffer: {
        active: {
          length: lines.length,
          viewportY: 0,
          getLine: (index: number) => ({ translateToString: () => lines[index] ?? '' })
        }
      }
    })
    expect(historyEndRow(screen(['$ python3 -m http.server', 'Serving…', '', ''], 4))).toBe(2)
    expect(historyEndRow(screen(['a', 'b', 'c', 'd'], 4))).toBeNull()
    expect(historyEndRow(screen(['', '', ''], 3))).toBeNull()
  })

  it('records when a hinted pane was captured (agent evidence after it means a relaunch)', () => {
    captureWakeProcessHint('leaf-1', running, {}, 1234)
    captureWakeProcessHint('leaf-idle', ['$ '], {}, 1234)
    expect(getWakeCaptureTime('leaf-1')).toBe(1234)
    expect(getWakeCaptureTime('leaf-idle')).toBeNull()
    dismissWakeProcessHint('leaf-1')
    expect(getWakeCaptureTime('leaf-1')).toBeNull()
  })

  it('tells a bare shell prompt from a screen that is still running something', () => {
    expect(endsAtShellPrompt(['No conversation found', 'ubuntu@sbx:~$ ', ''])).toBe(true)
    expect(endsAtShellPrompt(['> Try "fix lint"', '  ? for shortcuts'])).toBe(false)
    expect(endsAtShellPrompt([])).toBe(false)
  })

  // WAKE-RERUN: the pane as integration-keeper left it, `sleep 900` typed and Enter pressed.
  const xterm = (lines: string[], cursorRow: number) => ({
    buffer: {
      active: {
        length: lines.length,
        baseY: 0,
        cursorY: cursorRow,
        getLine: (index: number) => ({ translateToString: () => lines[index] ?? '' })
      }
    }
  })
  const sleeping = ['ubuntu@ik-wake:~/Hello-World/ik-wake$ sleep 900', '', '', '']

  it('reads whether the cursor sat below the last text (Enter pressed) or on it (half-typed)', () => {
    expect(cursorBelowLastText(xterm(sleeping, 1))).toBe(true)
    expect(cursorBelowLastText(xterm(sleeping, 0))).toBe(false)
    expect(cursorBelowLastText(xterm(['', ''], 1))).toBe(false)
  })

  it('a shell pane running a silent command captures Rerun with that command', () => {
    const pane = xterm(sleeping, 1)
    captureWakeProcessHint('leaf-shell', readTerminalTail(pane), {
      cursorBelowText: cursorBelowLastText(pane)
    })
    expect(getWakeProcessHint('leaf-shell')).toEqual({ command: 'sleep 900' })
  })

  it('reads the tail of an xterm buffer', () => {
    const lines = ['a', 'b', 'c']
    const terminal = {
      buffer: {
        active: {
          length: lines.length,
          getLine: (index: number) => ({ translateToString: () => lines[index]! })
        }
      }
    }
    expect(readTerminalTail(terminal, 2)).toEqual(['b', 'c'])
  })
})
