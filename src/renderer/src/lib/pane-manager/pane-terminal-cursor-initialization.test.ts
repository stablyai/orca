import { Terminal } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'
import { buildDefaultTerminalOptions } from './pane-terminal-options'

type CursorCoreService = { isCursorInitialized: boolean; isCursorHidden: boolean }

function hasCursorCoreService(
  value: unknown
): value is { _core: { coreService: CursorCoreService } } {
  if (typeof value !== 'object' || value === null || !('_core' in value)) {
    return false
  }
  const core = value._core
  return typeof core === 'object' && core !== null && 'coreService' in core
}

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

// agy's inline frame after startup: shows the hardware cursor once inside DEC 2026 and never re-asserts it.
const INLINE_AGENT_FRAME = '\x1b[?2026h\x1b[2J\x1b[H> \x1b[?25h\x1b[?2026l\x1b[?2026h'

describe('pane terminal cursor initialization', () => {
  it('draws the hardware cursor for a remounted inline TUI without waiting for focus or input', async () => {
    // A remounted pane is a fresh, never-focused xterm fed replay bytes with no focus event or keystroke.
    const terminal = new Terminal({ ...buildDefaultTerminalOptions(), cols: 80, rows: 24 })
    try {
      await write(terminal, INLINE_AGENT_FRAME)
      if (!hasCursorCoreService(terminal)) {
        throw new Error('xterm core service is unavailable')
      }
      const { coreService } = terminal._core
      expect({
        initialized: coreService.isCursorInitialized,
        hidden: coreService.isCursorHidden
      }).toEqual({ initialized: true, hidden: false })
    } finally {
      terminal.dispose()
    }
  })
})
