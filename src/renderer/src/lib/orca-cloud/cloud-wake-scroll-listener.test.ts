// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  armWakeScrollback,
  beginWakeScrollbackRestore,
  captureWakeScrollback,
  resetWakeScrollbackForTests
} from './cloud-wake-scrollback'
import { listenForWakeScroll } from './cloud-wake-scroll-listener'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

afterEach(() => resetWakeScrollbackForTests())

/** A cloud pane with kept pre-sleep output, an xterm-like viewport inside it that stops wheel propagation. */
function setup() {
  const container = document.createElement('div')
  const viewport = document.createElement('div')
  container.append(viewport)
  document.body.append(container)
  const xtermStops = vi.fn((event: Event) => event.stopPropagation())
  viewport.addEventListener('wheel', xtermStops)
  const terminal = { buffer: { active: { viewportY: 50, baseY: 50 } } }
  // Kept pre-sleep output for the leaf: one line of text in a 1-row buffer is enough.
  const cell = {
    getChars: () => 'x',
    getWidth: () => 1,
    isBold: () => 0,
    isDim: () => 0,
    isItalic: () => 0,
    isUnderline: () => 0,
    isBlink: () => 0,
    isInverse: () => 0,
    isInvisible: () => 0,
    isStrikethrough: () => 0,
    isFgDefault: () => true,
    isFgPalette: () => false,
    isFgRGB: () => false,
    getFgColor: () => 0,
    isBgDefault: () => true,
    isBgPalette: () => false,
    isBgRGB: () => false,
    getBgColor: () => 0
  }
  const normal = {
    length: 1,
    baseY: 0,
    getLine: () => ({ isWrapped: false, length: 1, getCell: () => cell })
  }
  captureWakeScrollback(
    'leaf-1',
    { rows: 1, buffer: { normal } },
    {
      sleptAt: 1,
      agentPane: false,
      maxRows: 5000
    }
  )
  armWakeScrollback(['leaf-1'])
  const frames: (() => void)[] = []
  const remove = listenForWakeScroll([{ leafId: 'leaf-1', container, terminal }], (callback) =>
    frames.push(callback)
  )
  // The remount on wake: at the bottom of a fresh buffer.
  const atBottomRemount = {
    rows: 1,
    scrollToLine: () => {},
    buffer: {
      active: { ...normal, type: 'normal', viewportY: 99, baseY: 99, cursorX: 0, cursorY: 0 }
    }
  }
  return { viewport, terminal, xtermStops, frames, remove, atBottomRemount }
}

describe('listenForWakeScroll (WAKE-SCROLLBACK-SCROLL)', () => {
  it("records the line from a wheel on xterm's viewport, which stops the wheel's propagation", () => {
    const { viewport, terminal, xtermStops, frames, atBottomRemount } = setup()
    const wheel = new WheelEvent('wheel', { deltaY: -400, bubbles: true, cancelable: true })
    viewport.dispatchEvent(wheel)
    // xterm still got it, and nothing was prevented: scrolling itself is untouched.
    expect(xtermStops).toHaveBeenCalledOnce()
    expect(wheel.defaultPrevented).toBe(false)
    // xterm applied the wheel; the position is read on the next frame.
    terminal.buffer.active.viewportY = 12
    frames.splice(0).forEach((frame) => frame())
    expect(beginWakeScrollbackRestore('leaf-1', atBottomRemount)?.scrolledTo).toBe(12)
  })

  it('is removed by its returned removal: a later wheel records nothing', () => {
    const { viewport, terminal, frames, remove, atBottomRemount } = setup()
    remove()
    viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }))
    terminal.buffer.active.viewportY = 12
    frames.splice(0).forEach((frame) => frame())
    expect(frames).toHaveLength(0)
    expect(beginWakeScrollbackRestore('leaf-1', atBottomRemount)?.scrolledTo).toBeNull()
  })
})
