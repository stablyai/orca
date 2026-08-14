import { describe, expect, it } from 'vitest'
import {
  TERMINAL_WORKBENCH_CLASS_NAMES,
  resolveTerminalWorkbenchPaintMode
} from './terminal-workbench-paintability'

describe('resolveTerminalWorkbenchPaintMode', () => {
  it('renders normally while the workspace view is showing', () => {
    expect(
      resolveTerminalWorkbenchPaintMode({
        isWorkbenchVisible: true,
        hasMobileDrivenBrowser: false
      })
    ).toBe('visible')
  })

  it('keeps the workbench painting when a phone drives a browser page off-workspace', () => {
    expect(
      resolveTerminalWorkbenchPaintMode({
        isWorkbenchVisible: false,
        hasMobileDrivenBrowser: true
      })
    ).toBe('paintable-hidden')
  })

  it('parks the workbench when nothing remote needs its pixels', () => {
    expect(
      resolveTerminalWorkbenchPaintMode({
        isWorkbenchVisible: false,
        hasMobileDrivenBrowser: false
      })
    ).toBe('parked')
  })
})

describe('TERMINAL_WORKBENCH_CLASS_NAMES', () => {
  it('never applies display:none to a mobile-driven workbench', () => {
    // Why: `hidden` is what stops screencast frames; opacity keeps compositing.
    expect(TERMINAL_WORKBENCH_CLASS_NAMES['paintable-hidden']).not.toMatch(/\bhidden\b/)
    expect(TERMINAL_WORKBENCH_CLASS_NAMES['paintable-hidden']).toContain('opacity-0')
  })

  it('keeps the hidden workbench out of flow and non-interactive', () => {
    // Why: the active page is a flex sibling — an in-flow workbench would
    // halve its height, and a hittable one would swallow its clicks.
    expect(TERMINAL_WORKBENCH_CLASS_NAMES['paintable-hidden']).toContain('absolute')
    expect(TERMINAL_WORKBENCH_CLASS_NAMES['paintable-hidden']).toContain('pointer-events-none')
  })

  it('still parks with display:none when no mobile client needs frames', () => {
    expect(TERMINAL_WORKBENCH_CLASS_NAMES.parked).toContain('hidden')
  })
})
