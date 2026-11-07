import { describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import {
  POST_REPLAY_MODE_RESET,
  RESET_GRAPHIC_RENDITION
} from '../../../../../shared/terminal/protocol/input-modes/terminal-mode-reset-profiles'
import { restoreScrollbackBuffers } from './saved-terminal-output-replay'

const LEAF_1 = '11111111-1111-4111-8111-111111111111'

describe('restoreScrollbackBuffers', () => {
  it('marks panes with restored scrollback for fresh-shell viewport blanking', () => {
    const writes: string[] = []
    const pane = {
      id: 1,
      terminal: {
        write: vi.fn((data: string, callback?: () => void) => {
          writes.push(data)
          callback?.()
        })
      }
    }
    const manager = {
      getPanes: vi.fn(() => [pane]),
      hasWebglRenderer: vi.fn(() => true)
    }
    const replayingPanesRef = { current: new Map<number, number>() }
    const restoredViewportBlankingPanesRef = { current: new Set<number>() }

    restoreScrollbackBuffers(
      manager as unknown as Parameters<typeof restoreScrollbackBuffers>[0],
      { [LEAF_1]: 'restored output' },
      new Map([[LEAF_1, 1]]),
      replayingPanesRef,
      restoredViewportBlankingPanesRef
    )

    expect(writes).toEqual([
      `${RESET_GRAPHIC_RENDITION}restored output${RESET_GRAPHIC_RENDITION}\r\n`,
      POST_REPLAY_MODE_RESET
    ])
    expect(manager.hasWebglRenderer).toHaveBeenCalledWith(1)
    expect(restoredViewportBlankingPanesRef.current.has(1)).toBe(true)
    expect(replayingPanesRef.current.size).toBe(0)
  })
})

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

  it('still leaves alt for a pane whose TUI did not survive', async () => {
    const terminal = await restoreInto()
    try {
      expect(terminal.buffer.active.type).toBe('normal')
      expect(visibleRows(terminal)[0]).toBe(LAUNCH)
    } finally {
      terminal.dispose()
    }
  })
})
