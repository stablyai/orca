import { describe, expect, it } from 'vitest'
import { clampTerminalViewport } from './terminal-viewport'
import { TerminalUpdateViewport } from './rpc-contract/terminal-viewport-schemas-params'

describe('terminal viewport', () => {
  it.each([240, 500, 1024])('preserves %i columns in the clamp and RPC', (cols) => {
    expect(clampTerminalViewport(cols, 40)).toEqual({ cols, rows: 40 })
    expect(
      TerminalUpdateViewport.parse({
        terminal: 'pty-1',
        client: { id: 'desktop-1' },
        viewport: { cols, rows: 40 }
      }).viewport
    ).toEqual({ cols, rows: 40 })
  })

  it('bounds oversized grids and preserves minimum dimensions and rounding', () => {
    expect(clampTerminalViewport(2000, 200)).toEqual({ cols: 1024, rows: 120 })
    expect(clampTerminalViewport(10, 4)).toEqual({ cols: 20, rows: 8 })
    expect(clampTerminalViewport(500.4, 40.6)).toEqual({ cols: 500, rows: 41 })
    expect(
      TerminalUpdateViewport.safeParse({
        terminal: 'pty-1',
        client: { id: 'desktop-1' },
        viewport: { cols: 1025, rows: 40 }
      }).success
    ).toBe(false)
  })
})
