import type { IBufferLine } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'
import { buildHardWrappedHttpLogicalLineCandidates } from './hard-wrapped-terminal-http-links'
import {
  TERMINAL_HTTP_URL_MAX_HARD_WRAPPED_ROWS,
  TERMINAL_HTTP_URL_MAX_LENGTH
} from './terminal-http-link-limits'

function bufferLine(text: string, onTranslateWithColumns: () => void): IBufferLine {
  return {
    isWrapped: false,
    length: text.length,
    translateToString: (
      _trimRight?: boolean,
      startColumn = 0,
      endColumn = text.length,
      outColumns?: number[]
    ) => {
      if (outColumns) {
        onTranslateWithColumns()
      }
      outColumns?.push(...Array.from({ length: text.length + 1 }, (_value, index) => index))
      return text.slice(startColumn, endColumn)
    }
  } as IBufferLine
}

function bufferLineWithCellColumns(text: string): IBufferLine {
  const columns: number[] = []
  let column = 0
  for (const character of text) {
    columns.push(column)
    column += character === '你' ? 2 : 1
  }
  columns.push(column)
  return {
    isWrapped: false,
    length: column,
    translateToString: (
      _trimRight?: boolean,
      startColumn = 0,
      endColumn = text.length,
      outColumns?: number[]
    ) => {
      outColumns?.push(...columns)
      return text.slice(startColumn, endColumn)
    }
  } as IBufferLine
}

describe('hard-wrapped terminal HTTP candidate bounds', () => {
  it('builds each required column map once and rejects an overlength candidate early', () => {
    const onTranslateWithColumns = vi.fn()
    const rows = Array.from({ length: TERMINAL_HTTP_URL_MAX_HARD_WRAPPED_ROWS }, (_value, index) =>
      bufferLine(`| ${index === 0 ? 'http://x' : 'aaaaaaaa'} |`, onTranslateWithColumns)
    )

    expect(
      buildHardWrappedHttpLogicalLineCandidates(
        { getLine: (y) => rows[y] },
        TERMINAL_HTTP_URL_MAX_HARD_WRAPPED_ROWS
      )
    ).toEqual([])
    expect(onTranslateWithColumns).toHaveBeenCalledTimes(
      Math.floor(TERMINAL_HTTP_URL_MAX_LENGTH / 'aaaaaaaa'.length) + 1
    )
  })

  it('does not build column maps while rejecting rows without an HTTP scheme', () => {
    const onTranslateWithColumns = vi.fn()
    const rows = Array.from({ length: TERMINAL_HTTP_URL_MAX_HARD_WRAPPED_ROWS }, () =>
      bufferLine(`| ${'a'.repeat(500)} |`, onTranslateWithColumns)
    )

    expect(
      buildHardWrappedHttpLogicalLineCandidates(
        { getLine: (y) => rows[y] },
        TERMINAL_HTTP_URL_MAX_HARD_WRAPPED_ROWS
      )
    ).toEqual([])
    expect(onTranslateWithColumns).not.toHaveBeenCalled()
  })

  it('reconstructs framed URL rows aligned by cells when a fragment has wide characters', () => {
    const rowTexts = ['|http://a/ab|', '|a你你你你你|', '|tailzzzzzzz|']
    const rows = rowTexts.map(bufferLineWithCellColumns)

    const candidates = buildHardWrappedHttpLogicalLineCandidates(
      { getLine: (y) => rows[y] },
      rows.length
    )

    expect(candidates[0]?.text).toBe('http://a/aba你你你你你tailzzzzzzz')
  })

  it('reconstructs a maximum-length wide-character URL beyond the ASCII row bound', () => {
    const scheme = 'http://'
    const continuation = '你'.repeat(TERMINAL_HTTP_URL_MAX_LENGTH - scheme.length)
    const rows = [
      bufferLineWithCellColumns(`|${scheme}|`),
      ...continuation
        .match(/.{1,3}/g)!
        .map((fragment) =>
          bufferLineWithCellColumns(`|${fragment}${' '.repeat(7 - fragment.length * 2)}|`)
        )
    ]

    expect(rows.length).toBeGreaterThan(Math.ceil(TERMINAL_HTTP_URL_MAX_LENGTH / scheme.length))
    expect(
      buildHardWrappedHttpLogicalLineCandidates({ getLine: (y) => rows[y] }, rows.length)[0]?.text
    ).toBe(scheme + continuation)
  })

  it('reconstructs a maximum-length URL with one-character continuation rows', () => {
    const firstFragment = 'http://a'
    const continuation = '/'.repeat(TERMINAL_HTTP_URL_MAX_LENGTH - firstFragment.length)
    const rows = [
      bufferLineWithCellColumns(`|${firstFragment}|`),
      ...continuation.split('').map((fragment) => bufferLineWithCellColumns(`|${fragment}       |`))
    ]
    const fullUrl = firstFragment + continuation

    expect(() => new URL(fullUrl)).not.toThrow()
    expect(
      buildHardWrappedHttpLogicalLineCandidates({ getLine: (y) => rows[y] }, rows.length)[0]?.text
    ).toBe(fullUrl)
  })
})
