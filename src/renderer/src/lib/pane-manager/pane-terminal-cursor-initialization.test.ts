import { Terminal, type ITerminalInitOnlyOptions, type ITerminalOptions } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'
import { buildDefaultTerminalOptions } from './pane-terminal-options'

type CursorCore = {
  _core: {
    coreService: { isCursorInitialized: boolean; isCursorHidden: boolean }
  }
}

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

// agy's inline frame after startup: shows the hardware cursor once inside DEC 2026 and never re-asserts it.
const INLINE_AGENT_FRAME = '\x1b[?2026h\x1b[2J\x1b[H> \x1b[?25h\x1b[?2026l\x1b[?2026h'

async function cursorDrawStateAfterRemount(
  options: ITerminalOptions & ITerminalInitOnlyOptions
): Promise<{ initialized: boolean; hidden: boolean }> {
  // A remounted pane is a fresh, never-focused xterm fed replay bytes with no focus event or keystroke.
  const terminal = new Terminal({ ...options, cols: 80, rows: 24 })
  try {
    await write(terminal, INLINE_AGENT_FRAME)
    const { coreService } = (terminal as unknown as CursorCore)._core
    return {
      initialized: coreService.isCursorInitialized,
      hidden: coreService.isCursorHidden
    }
  } finally {
    terminal.dispose()
  }
}

describe('pane terminal cursor initialization', () => {
  it('draws the hardware cursor for a remounted inline TUI without waiting for focus or input', async () => {
    expect(await cursorDrawStateAfterRemount(buildDefaultTerminalOptions())).toEqual({
      initialized: true,
      hidden: false
    })
  })

  it('documents the xterm default that hid it: no cursor until the first focus or keystroke', async () => {
    expect(
      await cursorDrawStateAfterRemount({
        ...buildDefaultTerminalOptions(),
        showCursorImmediately: false
      })
    ).toEqual({ initialized: false, hidden: false })
  })

  it('still lets the application hide the cursor with DECTCEM', async () => {
    const terminal = new Terminal({
      ...buildDefaultTerminalOptions(),
      cols: 80,
      rows: 24
    })
    try {
      await write(terminal, '\x1b[?25l')
      expect((terminal as unknown as CursorCore)._core.coreService.isCursorHidden).toBe(true)
    } finally {
      terminal.dispose()
    }
  })
})
