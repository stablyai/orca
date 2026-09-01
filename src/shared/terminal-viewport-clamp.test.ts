import { describe, expect, it } from 'vitest'
import { clampTerminalViewport } from './terminal-viewport-clamp'

describe('clampTerminalViewport', () => {
  it('leaves 240 and 500 columns unclamped', () => {
    expect(clampTerminalViewport(240, 24)).toEqual({ cols: 240, rows: 24 })
    expect(clampTerminalViewport(500, 24)).toEqual({ cols: 500, rows: 24 })
  })

  it('leaves 1024 columns at the ceiling', () => {
    expect(clampTerminalViewport(1024, 24)).toEqual({ cols: 1024, rows: 24 })
  })

  it('clamps 2000 columns to 1024', () => {
    expect(clampTerminalViewport(2000, 24)).toEqual({ cols: 1024, rows: 24 })
  })

  it('clamps columns below 20 up to 20', () => {
    expect(clampTerminalViewport(10, 24)).toEqual({ cols: 20, rows: 24 })
  })

  it('clamps rows below 8 up to 8', () => {
    expect(clampTerminalViewport(80, 4)).toEqual({ cols: 80, rows: 8 })
  })

  it('clamps rows above 120 down to 120', () => {
    expect(clampTerminalViewport(80, 200)).toEqual({ cols: 80, rows: 120 })
  })
})
