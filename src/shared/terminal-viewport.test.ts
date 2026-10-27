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

  it.each([121, 137, 500])('preserves %i rows in the clamp and RPC', (rows) => {
    expect(clampTerminalViewport(292, rows)).toEqual({ cols: 292, rows })
    expect(
      TerminalUpdateViewport.parse({
        terminal: 'pty-1',
        client: { id: 'desktop-1' },
        viewport: { cols: 292, rows }
      }).viewport
    ).toEqual({ cols: 292, rows })
  })

  it('bounds oversized grids and preserves minimum dimensions and rounding', () => {
    expect(clampTerminalViewport(2000, 5000)).toEqual({ cols: 1024, rows: 500 })
    expect(clampTerminalViewport(10, 4)).toEqual({ cols: 20, rows: 8 })
    expect(clampTerminalViewport(500.4, 40.6)).toEqual({ cols: 500, rows: 41 })
    expect(
      TerminalUpdateViewport.safeParse({
        terminal: 'pty-1',
        client: { id: 'desktop-1' },
        viewport: { cols: 1025, rows: 40 }
      }).success
    ).toBe(false)
    expect(
      TerminalUpdateViewport.safeParse({
        terminal: 'pty-1',
        client: { id: 'desktop-1' },
        viewport: { cols: 292, rows: 501 }
      }).success
    ).toBe(false)
  })
})
