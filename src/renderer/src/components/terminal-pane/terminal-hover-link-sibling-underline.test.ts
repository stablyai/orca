import { describe, expect, it, vi } from 'vitest'
import type { IBufferLine } from '@xterm/xterm'
import {
  createSiblingLinkUnderliner,
  linkRowSegmentsFromRanges,
  oscLinkSegmentOnLine,
  oscLinkSiblingSegments
} from './terminal-hover-link-sibling-underline'

// #33553: a TUI writing each row of a long URL itself (OSC 8 reopened per row) leaves
// isWrapped false, so every row is its own link and only the hovered row underlines.
// These tests pin the sibling-row segments the underliner must cover.

function oscLine(urlId: number, from: number, to: number, length = 80): IBufferLine {
  const cells = Array.from({ length }, (_, x) => ({
    hasExtendedAttrs: () => x >= from && x <= to,
    extended: { urlId }
  }))
  return {
    length,
    getCell: (x: number) => cells[x] ?? null
  } as unknown as IBufferLine
}

function plainLine(length = 80): IBufferLine {
  return {
    length,
    getCell: () => ({ hasExtendedAttrs: () => false })
  } as unknown as IBufferLine
}

describe('oscLinkSegmentOnLine', () => {
  it('finds the contiguous urlId run on a row', () => {
    expect(oscLinkSegmentOnLine(oscLine(7, 3, 59), 7)).toEqual({ startX: 3, endX: 59 })
  })

  it('returns null when the row has no cell with the id', () => {
    expect(oscLinkSegmentOnLine(plainLine(), 7)).toBeNull()
  })
})

describe('oscLinkSiblingSegments', () => {
  // getLine takes a 0-based index: buffer row 1 = getLine(0).
  const buffer = {
    getLine: (y: number) =>
      y === 0 ? oscLine(7, 3, 79) : y === 1 ? oscLine(7, 3, 59) : plainLine()
  }

  it('returns the row below when hovering the first row of a two-row link', () => {
    expect(oscLinkSiblingSegments(buffer, 1, 10)).toEqual([{ y: 2, startX: 4, endX: 60 }])
  })

  it('returns the row above when hovering the second row', () => {
    expect(oscLinkSiblingSegments(buffer, 2, 10)).toEqual([{ y: 1, startX: 4, endX: 80 }])
  })

  it('stops at the first row without the id', () => {
    expect(oscLinkSiblingSegments(buffer, 3, 10)).toEqual([])
  })

  it('returns nothing when the hovered cell has no link id', () => {
    expect(oscLinkSiblingSegments(buffer, 1, 1)).toEqual([])
  })

  it('matches a row that reopens the same URI with a different id (no id=)', () => {
    // Two rows, each its own opening: ids 7 and 8, same URI behind both.
    const rows = [oscLine(7, 3, 79), oscLine(8, 3, 59)]
    const uriBuffer = { getLine: (y: number) => rows[y] ?? plainLine() }
    const resolveUri = (id: number) => (id === 7 || id === 8 ? 'https://same.example/u' : undefined)
    expect(oscLinkSiblingSegments(uriBuffer, 1, 10, resolveUri)).toEqual([
      { y: 2, startX: 4, endX: 60 }
    ])
  })

  it('does not match a different URI even with a resolver', () => {
    const rows = [oscLine(7, 3, 79), oscLine(8, 3, 59)]
    const uriBuffer = { getLine: (y: number) => rows[y] ?? plainLine() }
    const resolveUri = (id: number) => (id === 7 ? 'https://a.example/' : 'https://b.example/')
    expect(oscLinkSiblingSegments(uriBuffer, 1, 10, resolveUri)).toEqual([])
  })
})

describe('linkRowSegmentsFromRanges', () => {
  it('converts 1-based IBufferRange values to inclusive segments', () => {
    expect(
      linkRowSegmentsFromRanges([{ start: { x: 2, y: 2 }, end: { x: 33, y: 2 } }])
    ).toEqual([{ y: 2, startX: 2, endX: 32 }])
  })
})

describe('createSiblingLinkUnderliner', () => {
  function makeTerminal() {
    const decorations: {
      options: { marker: unknown; x?: number; width?: number }
      dispose: () => void
      onRender: (cb: (el: HTMLElement) => void) => void
    }[] = []
    const marker = { line: 0, dispose: vi.fn() }
    return {
      decorations,
      terminal: {
        registerMarker: vi.fn(() => marker),
        registerDecoration: vi.fn((options: { x?: number; width?: number }) => {
          const decoration = {
            options: { ...options, marker },
            dispose: vi.fn(function (this: { disposed?: boolean }) {
              ;(this as { disposed?: boolean }).disposed = true
            }),
            onRender: vi.fn()
          }
          decorations.push(decoration as never)
          return decoration
        }),
        buffer: {
          active: { baseY: 0, cursorY: 0 }
        }
      }
    }
  }

  it('registers one decoration per sibling segment and disposes them on clear', () => {
    const { terminal, decorations } = makeTerminal()
    const underliner = createSiblingLinkUnderliner(terminal as never)
    underliner.underline([
      { y: 2, startX: 4, endX: 60 },
      { y: 3, startX: 4, endX: 20 }
    ])
    expect(terminal.registerDecoration).toHaveBeenCalledTimes(2)
    expect(terminal.registerMarker).toHaveBeenCalledWith(1)
    expect(decorations).toHaveLength(2)
    underliner.clear()
    expect(terminal.registerDecoration).toHaveBeenCalledTimes(2)
  })

  it('replaces previous underlines on the next hover', () => {
    const { terminal } = makeTerminal()
    const underliner = createSiblingLinkUnderliner(terminal as never)
    underliner.underline([{ y: 2, startX: 4, endX: 60 }])
    underliner.underline([{ y: 1, startX: 4, endX: 80 }])
    expect(terminal.registerDecoration).toHaveBeenCalledTimes(2)
  })

  it('disposes the marker with the decoration on clear (#33589 review)', () => {
    const { terminal } = makeTerminal()
    const marker = { line: 0, dispose: vi.fn() }
    terminal.registerMarker.mockImplementation(() => marker)
    const underliner = createSiblingLinkUnderliner(terminal as never)
    underliner.underline([{ y: 2, startX: 4, endX: 60 }])
    underliner.clear()
    expect(marker.dispose).toHaveBeenCalledTimes(1)
  })
})
