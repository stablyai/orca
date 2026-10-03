// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IBuffer, IBufferCell, IBufferLine, Terminal } from '@xterm/xterm'
import { installTerminalImeCandidateAnchor } from './terminal-ime-candidate-anchor'

const COLS = 80
const ROWS = 24
const CELL_WIDTH = 8
const CELL_HEIGHT = 17

type AnchorHarness = {
  terminal: Terminal
  element: HTMLElement
  style: { top: string; left: string; width: string }
  compositionStyle: CSSStyleDeclaration
  counts: { rectReads: number; styleWrites: number }
  setCursor: (cursorX: number, cursorY: number) => void
  /** Hides the cursor and paints the app's own caret as one inverse cell, as cursor-agent does. */
  setScreen: (lines: string[], caret: { row: number; column: number } | null) => void
}

function makeLine(text: string, inverseColumns: ReadonlySet<number>): IBufferLine {
  const chars = Array.from(text)
  while (chars.length < COLS) {
    chars.push(' ')
  }
  const cellAt = (column: number): IBufferCell | undefined => {
    const char = chars[column]
    return char === undefined
      ? undefined
      : // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads only width, chars and inverse.
        ({
          getWidth: () => 1,
          getChars: () => (char === ' ' ? '' : char),
          isInverse: () => (inverseColumns.has(column) ? 1 : 0)
        } as IBufferCell)
  }
  return {
    isWrapped: false,
    length: chars.length,
    getCell: cellAt,
    translateToString: (trimRight = false, start = 0, end = chars.length) => {
      const result = chars.slice(start, end).join('')
      return trimRight ? result.replace(/\s+$/, '') : result
    }
  } as IBufferLine
}

function createHarness(): AnchorHarness {
  const counts = { rectReads: 0, styleWrites: 0 }
  const element = document.createElement('div')
  const screen = document.createElement('div')
  screen.className = 'xterm-screen'
  const compositionView = document.createElement('div')
  compositionView.className = 'composition-view'
  screen.appendChild(compositionView)
  element.appendChild(screen)
  document.body.appendChild(element)

  screen.getBoundingClientRect = (): DOMRect => {
    counts.rectReads++
    return { width: COLS * CELL_WIDTH, height: ROWS * CELL_HEIGHT } as DOMRect
  }

  // `width` is xterm's, not ours: it sizes the textarea to the preedit just before this
  // listener runs, and the clamp reads it back to keep that box inside the screen.
  const style = { top: '', left: '', width: '' }
  const textarea = {
    isConnected: true,
    style: new Proxy(style, {
      set(target, key: string, value: string) {
        counts.styleWrites++
        target[key as 'top' | 'left' | 'width'] = value
        return true
      }
    })
  } as unknown as HTMLTextAreaElement

  let lines = ['']
  let caret: { row: number; column: number } | null = null
  const noInverse = new Set<number>()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the anchor reads only these buffer members.
  const buffer = {
    baseY: 0,
    cursorX: 0,
    cursorY: 0,
    length: ROWS,
    getNullCell: () => undefined,
    getLine: (row: number) =>
      makeLine(lines[row] ?? '', caret?.row === row ? new Set([caret.column]) : noInverse)
  } as unknown as IBuffer

  const modes = { showCursor: true }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the anchor reads only these terminal members.
  const terminal = {
    element,
    textarea,
    cols: COLS,
    rows: ROWS,
    modes,
    buffer: { active: buffer }
  } as unknown as Terminal

  return {
    terminal,
    element,
    style,
    compositionStyle: compositionView.style,
    counts,
    setCursor: (cursorX: number, cursorY: number) => {
      Object.assign(buffer, { cursorX, cursorY })
    },
    setScreen: (next, nextCaret) => {
      lines = next
      caret = nextCaret
      modes.showCursor = false
    }
  }
}

function fire(element: HTMLElement, type: string): void {
  element.dispatchEvent(new Event(type))
}

/** One Hangul syllable: xterm sees compositionstart then one update per jamo. */
function typeHangulSyllable(
  harness: AnchorHarness,
  cursorX: number,
  updates = 3,
  cursorY = 0
): void {
  harness.setCursor(cursorX, cursorY)
  fire(harness.element, 'compositionstart')
  for (let update = 0; update < updates; update++) {
    fire(harness.element, 'compositionupdate')
  }
}

describe('installTerminalImeCandidateAnchor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('returns null before the terminal has opened its DOM', () => {
    expect(installTerminalImeCandidateAnchor({ element: null } as unknown as Terminal)).toBeNull()
  })

  it('keeps forced layout at one read per composition across a Hangul burst', () => {
    const harness = createHarness()
    installTerminalImeCandidateAnchor(harness.terminal)

    for (let syllable = 0; syllable < 30; syllable++) {
      typeHangulSyllable(harness, syllable)
    }

    // 30 compositions x 4 events: reads collapse to one per composition, and the
    // 90 updates re-write nothing because the anchor is already on the textarea.
    expect(harness.counts.rectReads).toBe(30)
    expect(harness.counts.styleWrites).toBe(31)
    expect(harness.style.left).toBe(`${29 * CELL_WIDTH}px`)
  })

  it('pulls an over-wide preedit anchor back inside the terminal at the last column', () => {
    const harness = createHarness()
    installTerminalImeCandidateAnchor(harness.terminal)
    // xterm sized the textarea to a two-cell preedit that starts in the final column.
    harness.style.width = `${2 * CELL_WIDTH}px`

    typeHangulSyllable(harness, COLS - 1)

    // Without the clamp this is 79 cells, putting the OS candidate window one cell past the
    // right edge while xterm end-aligns the visible preedit back inside.
    expect(harness.style.left).toBe(`${(COLS - 2) * CELL_WIDTH}px`)
  })

  it('never anchors left of the terminal when the preedit outgrows the whole row', () => {
    const harness = createHarness()
    installTerminalImeCandidateAnchor(harness.terminal)
    // A long pinyin phrase in a narrow pane: the preedit is wider than every column together.
    harness.style.width = `${(COLS + 12) * CELL_WIDTH}px`

    typeHangulSyllable(harness, COLS - 1)

    expect(harness.style.left).toBe('0px')
  })

  it('leaves the anchor on the cursor cell while the preedit still fits', () => {
    const harness = createHarness()
    installTerminalImeCandidateAnchor(harness.terminal)
    harness.style.width = `${2 * CELL_WIDTH}px`

    typeHangulSyllable(harness, 40)

    expect(harness.style.left).toBe(`${40 * CELL_WIDTH}px`)
  })

  it('does no work for Latin input, which fires no composition events', () => {
    const harness = createHarness()
    installTerminalImeCandidateAnchor(harness.terminal)

    fire(harness.element, 'keydown')
    fire(harness.element, 'input')

    expect(harness.counts).toEqual({ rectReads: 0, styleWrites: 0 })
  })

  it('re-corrects the anchor mid-composition after xterm rewrites the textarea', () => {
    const harness = createHarness()
    installTerminalImeCandidateAnchor(harness.terminal)
    harness.setCursor(4, 2)
    fire(harness.element, 'compositionstart')

    // xterm's own compositionupdate handler repositions from its uncorrected
    // cursor; long CJK compositions depend on us winning that back.
    harness.style.top = '0px'
    harness.setCursor(6, 2)
    fire(harness.element, 'compositionupdate')

    expect(harness.style).toEqual({
      top: `${2 * CELL_HEIGHT}px`,
      left: `${6 * CELL_WIDTH}px`,
      width: ''
    })
  })

  it('re-measures mid-composition when the terminal is refit to new dimensions', () => {
    const harness = createHarness()
    installTerminalImeCandidateAnchor(harness.terminal)
    fire(harness.element, 'compositionstart')
    expect(harness.counts.rectReads).toBe(1)

    Object.assign(harness.terminal, { cols: 40 })
    fire(harness.element, 'compositionupdate')

    expect(harness.counts.rectReads).toBe(2)
  })

  it('coalesces the deferred app-caret re-apply to one timer per burst', () => {
    const harness = createHarness()
    harness.setScreen(['Cursor Agent', '', '→ hello'], { row: 2, column: 7 })
    installTerminalImeCandidateAnchor(harness.terminal)

    typeHangulSyllable(harness, 0, 5, 1)

    expect(vi.getTimerCount()).toBe(1)
    harness.style.top = '0px'
    vi.runAllTimers()
    expect(harness.style).toEqual({
      top: `${2 * CELL_HEIGHT}px`,
      left: `${7 * CELL_WIDTH}px`,
      width: ''
    })
  })

  it("re-queues the correction after xterm's latest composition timer", () => {
    const harness = createHarness()
    harness.setScreen(['Cursor Agent', '', '→ hello'], { row: 2, column: 7 })
    harness.element.addEventListener('compositionupdate', () => {
      window.setTimeout(() => {
        harness.style.top = '0px'
      }, 0)
    })
    installTerminalImeCandidateAnchor(harness.terminal)

    harness.setCursor(0, 1)
    fire(harness.element, 'compositionstart')
    fire(harness.element, 'compositionupdate')
    vi.runAllTimers()

    expect(harness.style.top).toBe(`${2 * CELL_HEIGHT}px`)
  })

  it('keeps the relocated preedit overlay on the textarea anchor', () => {
    const harness = createHarness()
    harness.setScreen(['Cursor Agent', '', '→ hello'], { row: 2, column: 7 })
    harness.element.addEventListener('compositionupdate', () => {
      window.setTimeout(() => {
        harness.style.top = `${CELL_HEIGHT}px`
        harness.compositionStyle.top = `${CELL_HEIGHT}px`
        harness.compositionStyle.left = '0px'
      }, 0)
    })
    installTerminalImeCandidateAnchor(harness.terminal)

    harness.setCursor(0, 1)
    fire(harness.element, 'compositionstart')
    fire(harness.element, 'compositionupdate')
    vi.runAllTimers()

    expect(harness.style).toEqual({
      top: `${2 * CELL_HEIGHT}px`,
      left: `${7 * CELL_WIDTH}px`,
      width: ''
    })
    expect(harness.compositionStyle.top).toBe(`${2 * CELL_HEIGHT}px`)
    expect(harness.compositionStyle.left).toBe(`${7 * CELL_WIDTH}px`)
    expect(harness.compositionStyle.height).toBe(`${CELL_HEIGHT}px`)
    expect(harness.compositionStyle.lineHeight).toBe(`${CELL_HEIGHT}px`)
  })

  it('follows the app caret from the placeholder to typed text after the header scrolls away', () => {
    const harness = createHarness()
    harness.setScreen(['Cursor Agent', '', '→ Plan, search, build anything', ''], {
      row: 2,
      column: 2
    })
    installTerminalImeCandidateAnchor(harness.terminal)
    typeHangulSyllable(harness, 0, 1, 3)

    harness.setScreen(['transcript', '', '→ hello', ''], { row: 2, column: 7 })
    harness.style.left = '0px'
    fire(harness.element, 'compositionupdate')
    vi.runAllTimers()

    expect(harness.style).toEqual({
      top: `${2 * CELL_HEIGHT}px`,
      left: `${7 * CELL_WIDTH}px`,
      width: ''
    })
    expect(harness.compositionStyle.left).toBe(`${7 * CELL_WIDTH}px`)
  })

  it('refreshes the deferred metrics and anchor after a refit', () => {
    const harness = createHarness()
    harness.setScreen(['Cursor Agent', '', '→ hello'], { row: 2, column: 7 })
    installTerminalImeCandidateAnchor(harness.terminal)
    typeHangulSyllable(harness, 0, 5, 1)

    Object.assign(harness.terminal, { cols: 40 })
    harness.setScreen(['Cursor Agent', '', '', '→ hello'], { row: 3, column: 7 })
    harness.style.top = '0px'
    vi.runAllTimers()

    expect(harness.counts.rectReads).toBe(2)
    expect(harness.style).toEqual({
      top: `${3 * CELL_HEIGHT}px`,
      left: `${14 * CELL_WIDTH}px`,
      width: ''
    })
  })

  it('stops writing once the textarea has been detached', () => {
    const harness = createHarness()
    harness.setScreen(['Cursor Agent', '', '→ hello'], { row: 2, column: 7 })
    installTerminalImeCandidateAnchor(harness.terminal)
    typeHangulSyllable(harness, 0, 1, 1)

    Object.assign(harness.terminal.textarea as object, { isConnected: false })
    const writesBeforeTimer = harness.counts.styleWrites
    harness.style.top = '0px'
    vi.runAllTimers()

    expect(harness.counts.styleWrites).toBe(writesBeforeTimer)
  })

  it('keeps following the shown cursor when an inverse cell is only decoration', () => {
    const harness = createHarness()
    harness.setScreen(['> menu', '', '❯ hi'], { row: 0, column: 0 })
    Object.assign(harness.terminal.modes, { showCursor: true })
    installTerminalImeCandidateAnchor(harness.terminal)

    typeHangulSyllable(harness, 4, 1, 2)

    expect(harness.style.top).toBe(`${2 * CELL_HEIGHT}px`)
    expect(harness.style.left).toBe(`${4 * CELL_WIDTH}px`)
    expect(harness.compositionStyle.top).toBe('')
  })

  it('carries the caret through a repaint that briefly paints none, within one composition', () => {
    const harness = createHarness()
    harness.setScreen(['', '→ hi'], { row: 1, column: 4 })
    installTerminalImeCandidateAnchor(harness.terminal)
    typeHangulSyllable(harness, 0, 1, 5)

    harness.setScreen(['', ''], null)
    fire(harness.element, 'compositionupdate')
    expect(harness.style.left).toBe(`${4 * CELL_WIDTH}px`)

    fire(harness.element, 'compositionstart')
    expect(harness.style.top).toBe(`${5 * CELL_HEIGHT}px`)
    expect(harness.style.left).toBe('0px')
  })
})
