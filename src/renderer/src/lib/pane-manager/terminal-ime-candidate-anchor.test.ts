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
  style: { top: string; left: string }
  compositionStyle: CSSStyleDeclaration
  counts: { rectReads: number; styleWrites: number }
  setCursor: (cursorX: number, cursorY: number) => void
  setLines: (lines: string[]) => void
}

function makeLine(text: string): IBufferLine {
  const chars = Array.from(text)
  while (chars.length < COLS) {
    chars.push(' ')
  }
  const cellAt = (column: number): IBufferCell | undefined => {
    const char = chars[column]
    return char === undefined
      ? undefined
      : ({ getWidth: () => 1, getChars: () => (char === ' ' ? '' : char) } as IBufferCell)
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

  const style = { top: '', left: '' }
  const textarea = {
    isConnected: true,
    style: new Proxy(style, {
      set(target, key: string, value: string) {
        counts.styleWrites++
        target[key as 'top' | 'left'] = value
        return true
      }
    })
  } as unknown as HTMLTextAreaElement

  let lines = ['']
  const buffer = {
    baseY: 0,
    cursorX: 0,
    cursorY: 0,
    length: ROWS,
    getLine: (row: number) => (row < lines.length ? makeLine(lines[row] ?? '') : makeLine(''))
  } as unknown as IBuffer

  const terminal = {
    element,
    textarea,
    cols: COLS,
    rows: ROWS,
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
    setLines: (next: string[]) => {
      lines = next
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

    expect(harness.style).toEqual({ top: `${2 * CELL_HEIGHT}px`, left: `${6 * CELL_WIDTH}px` })
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

  it('coalesces the deferred Cursor Agent re-apply to one timer per burst', () => {
    const harness = createHarness()
    harness.setLines(['Cursor Agent', '', '→ hello'])
    installTerminalImeCandidateAnchor(harness.terminal)

    typeHangulSyllable(harness, 0, 5, 1)

    expect(vi.getTimerCount()).toBe(1)
    harness.style.top = '0px'
    vi.runAllTimers()
    expect(harness.style).toEqual({ top: `${2 * CELL_HEIGHT}px`, left: `${7 * CELL_WIDTH}px` })
  })

  it("re-queues the correction after xterm's latest composition timer", () => {
    const harness = createHarness()
    harness.setLines(['Cursor Agent', '', '→ hello'])
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

  it('keeps the Cursor Agent preedit overlay on the textarea anchor', () => {
    const harness = createHarness()
    harness.setLines(['Cursor Agent', '', '→ hello'])
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

    expect(harness.style).toEqual({ top: `${2 * CELL_HEIGHT}px`, left: `${7 * CELL_WIDTH}px` })
    expect(harness.compositionStyle.top).toBe(`${2 * CELL_HEIGHT}px`)
    expect(harness.compositionStyle.left).toBe(`${7 * CELL_WIDTH}px`)
    expect(harness.compositionStyle.height).toBe(`${CELL_HEIGHT}px`)
    expect(harness.compositionStyle.lineHeight).toBe(`${CELL_HEIGHT}px`)
  })

  it('keeps typed follow-ups anchored after recognizing the initial Cursor Agent screen', () => {
    const harness = createHarness()
    harness.setLines(['Cursor Agent', '', '→ Plan, search, build anything', ''])
    installTerminalImeCandidateAnchor(harness.terminal)
    typeHangulSyllable(harness, 0, 1, 3)

    harness.setLines(['transcript', '', '→ hello', ''])
    harness.style.left = '0px'
    fire(harness.element, 'compositionupdate')
    vi.runAllTimers()

    expect(harness.style).toEqual({ top: `${2 * CELL_HEIGHT}px`, left: `${7 * CELL_WIDTH}px` })
    expect(harness.compositionStyle.left).toBe(`${7 * CELL_WIDTH}px`)
  })

  it('refreshes the deferred metrics and anchor after a refit', () => {
    const harness = createHarness()
    harness.setLines(['Cursor Agent', '', '→ hello'])
    installTerminalImeCandidateAnchor(harness.terminal)
    typeHangulSyllable(harness, 0, 5, 1)

    Object.assign(harness.terminal, { cols: 40 })
    harness.setLines(['Cursor Agent', '', '', '→ hello'])
    harness.style.top = '0px'
    vi.runAllTimers()

    expect(harness.counts.rectReads).toBe(2)
    expect(harness.style).toEqual({ top: `${3 * CELL_HEIGHT}px`, left: `${14 * CELL_WIDTH}px` })
  })

  it('stops writing once the textarea has been detached', () => {
    const harness = createHarness()
    harness.setLines(['Cursor Agent', '', '→ hello'])
    installTerminalImeCandidateAnchor(harness.terminal)
    typeHangulSyllable(harness, 0, 1, 1)

    Object.assign(harness.terminal.textarea as object, { isConnected: false })
    const writesBeforeTimer = harness.counts.styleWrites
    harness.style.top = '0px'
    vi.runAllTimers()

    expect(harness.counts.styleWrites).toBe(writesBeforeTimer)
  })
})
