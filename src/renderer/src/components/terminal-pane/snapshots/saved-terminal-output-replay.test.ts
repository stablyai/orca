import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import '../../../../../shared/terminal/protocol/input-modes/terminal-mode-reset-profiles'
import { restoreScrollbackBuffers } from './saved-terminal-output-replay'

const LEAF_1 = '11111111-1111-4111-8111-111111111111'

describe('restoreScrollbackBuffers over a parked live TUI', () => {
  // A fresh agent tab: the launch line on row 0, then the TUI on the alt screen.
  const LAUNCH = "~/workspaces/wt$ pi '--session' '/home/u/.pi/agent/sessions/a.jsonl'"
  const CAPTURED = `${LAUNCH}\r\n\x1b[?1049h\x1b[H\x1b[2mTUI header\x1b[0m\x1b[3;1HTUI body`

  async function restoreInto(liveAltScreenLeafIds?: ReadonlySet<string>): Promise<Terminal> {
    const terminal = new Terminal({ cols: 80, rows: 6, allowProposedApi: true })
    const pane = { id: 1, terminal }
    const manager = { getPanes: () => [pane], hasWebglRenderer: () => true }
    restoreScrollbackBuffers(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: restore reads only getPanes/hasWebglRenderer and the pane's id and terminal.
      manager as unknown as Parameters<typeof restoreScrollbackBuffers>[0],
      { [LEAF_1]: CAPTURED },
      new Map([[LEAF_1, 1]]),
      { current: new Map<number, number>() },
      { current: new Set<number>() },
      liveAltScreenLeafIds
    )
    await new Promise<void>((resolve) => terminal.write('', resolve))
    return terminal
  }

  function visibleRows(terminal: Terminal): string[] {
    const buffer = terminal.buffer.active
    return Array.from(
      { length: terminal.rows },
      (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? ''
    )
  }

  // Keep the live TUI frame until the host snapshot arrives; otherwise reveal flashes the shell launch line (#22087).
  it('keeps the TUI frame of a remote pane the host still runs', async () => {
    const terminal = await restoreInto(new Set([LEAF_1]))
    try {
      expect(terminal.buffer.active.type).toBe('alternate')
      expect(visibleRows(terminal).join('\n')).not.toContain('--session')
      expect(visibleRows(terminal)[0]).toBe('TUI header')
      expect(terminal.buffer.normal.getLine(0)?.translateToString(true)).toBe(LAUNCH)
    } finally {
      terminal.dispose()
    }
  })
})
