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

  // Read xterm’s just-written preedit width so the clamp preserves its box inside the screen.
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

  it('keeps typed follow-ups anchored after recognizing the initial Cursor Agent screen', () => {
    const harness = createHarness()
    harness.setLines(['Cursor Agent', '', '→ Plan, search, build anything', ''])
    installTerminalImeCandidateAnchor(harness.terminal)
    typeHangulSyllable(harness, 0, 1, 3)

    harness.setLines(['transcript', '', '→ hello', ''])
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
    harness.setLines(['Cursor Agent', '', '→ hello'])
    installTerminalImeCandidateAnchor(harness.terminal)
    typeHangulSyllable(harness, 0, 5, 1)

    Object.assign(harness.terminal, { cols: 40 })
    harness.setLines(['Cursor Agent', '', '', '→ hello'])
    harness.style.top = '0px'
    vi.runAllTimers()

    expect(harness.counts.rectReads).toBe(2)
    expect(harness.style).toEqual({
      top: `${3 * CELL_HEIGHT}px`,
      left: `${14 * CELL_WIDTH}px`,
      width: ''
    })
  })
})
