import { describe, expect, it } from 'vitest'

import {
  writeForegroundTerminalChunk,
  type ForegroundTerminalOutputTarget
} from './pane-terminal-foreground-render-settle'

type SpanRequest = { start: number; end: number }

describe('foreground repaint convergence', () => {
  it('widens the repair to the cursor rows on both sides of the write', () => {
    // A controlled span proves Orca adds cursor rows; xterm’s own tracker already includes them and would mask missing repair.
    const requests: SpanRequest[] = []
    let fire: (event: { start: number; end: number } | undefined) => void = () => {}
    const active = { type: 'normal', cursorY: 2, baseY: 0, viewportY: 0 }
    const target: ForegroundTerminalOutputTarget = {
      rows: 24,
      buffer: { active },
      refresh: (start, end) => requests.push({ start, end }),
      write: (_data, callback) => {
        fire({ start: 8, end: 9 })
        active.cursorY = 17
        callback?.()
      },
      _core: {
        _inputHandler: {
          onRequestRefreshRows: (listener) => {
            fire = listener
            return { dispose: () => {} }
          }
        }
      }
    } as unknown as ForegroundTerminalOutputTarget
    writeForegroundTerminalChunk(target, 'x', {
      forceViewportRefresh: true,
      shouldRefreshViewportSynchronously: () => false
    })
    expect(requests).toEqual([{ start: 2, end: 17 }])
  })
})
