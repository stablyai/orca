import { describe, expect, it } from 'vitest'
import {
  TERMINAL_TUI_MOUSE_WHEEL_MULTIPLIER,
  normalizeTerminalTuiMouseWheelMultiplier,
  shouldMultiplyTerminalMouseWheel
} from './pane-terminal-mouse-wheel'

const DOM_DELTA_PIXEL = 0
const DOM_DELTA_LINE = 1

function terminalElement(mouseReporting = true): HTMLElement {
  return {
    classList: {
      contains: (className: string) => mouseReporting && className === 'enable-mouse-events'
    }
  } as HTMLElement
}

function wheelEvent(init: Partial<WheelEventInit> = {}): WheelEvent {
  return {
    deltaY: 100,
    deltaMode: DOM_DELTA_PIXEL,
    ...init
  } as WheelEvent
}

describe('terminal mouse wheel multiplier', () => {
  it('uses a three-report multiplier for TUI mouse wheel scrolling', () => {
    expect(TERMINAL_TUI_MOUSE_WHEEL_MULTIPLIER).toBe(3)
  })

  it('normalizes TUI wheel multipliers to the supported report range', () => {
    expect(normalizeTerminalTuiMouseWheelMultiplier(undefined)).toBe(3)
    expect(normalizeTerminalTuiMouseWheelMultiplier(0)).toBe(1)
    expect(normalizeTerminalTuiMouseWheelMultiplier(4.4)).toBe(4)
    expect(normalizeTerminalTuiMouseWheelMultiplier(20)).toBe(10)
  })

  it('multiplies discrete wheel events when mouse reporting is active', () => {
    expect(shouldMultiplyTerminalMouseWheel(wheelEvent(), terminalElement())).toBe(true)
  })

  it('leaves normal terminal scrollback alone', () => {
    expect(shouldMultiplyTerminalMouseWheel(wheelEvent(), terminalElement(false))).toBe(false)
  })

  it('leaves trackpad-like pixel scrolling one-to-one', () => {
    expect(
      shouldMultiplyTerminalMouseWheel(
        wheelEvent({
          deltaY: 12,
          deltaMode: DOM_DELTA_PIXEL
        }),
        terminalElement()
      )
    ).toBe(false)
  })

  it('multiplies non-pixel wheel deltas as discrete input', () => {
    expect(
      shouldMultiplyTerminalMouseWheel(
        wheelEvent({
          deltaY: 1,
          deltaMode: DOM_DELTA_LINE
        }),
        terminalElement()
      )
    ).toBe(true)
  })

  it('ignores horizontal shift-wheel events', () => {
    expect(
      shouldMultiplyTerminalMouseWheel(
        wheelEvent({
          shiftKey: true
        }),
        terminalElement()
      )
    ).toBe(false)
  })
})
