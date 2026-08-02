import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  IPYNB_CODE_CELL_EDITOR_HEIGHT_SCAN_CODE_UNITS,
  IPYNB_CODE_CELL_PREVIEW_LINE_MAX_CODE_UNITS,
  IPYNB_CODE_CELL_PREVIEW_MAX_LINES,
  IPYNB_CODE_CELL_PREVIEW_SCAN_CODE_UNITS,
  getIpynbCodeCellEditorHeight,
  getIpynbCodeCellPreviewLines
} from './ipynb-code-cell-lines'

const FONT_SIZE = 13

afterEach(() => {
  vi.restoreAllMocks()
})

describe('notebook code cell line derivation', () => {
  it('preserves small cell height and preview lines including CRLF content', () => {
    expect(getIpynbCodeCellEditorHeight('', FONT_SIZE)).toBe(96)
    expect(getIpynbCodeCellEditorHeight('one line', FONT_SIZE)).toBe(96)
    expect(getIpynbCodeCellEditorHeight('one\ntwo\nthree\nfour', FONT_SIZE)).toBe(105)

    expect(getIpynbCodeCellPreviewLines('')).toEqual([''])
    expect(getIpynbCodeCellPreviewLines('one\ntwo\n')).toEqual(['one', 'two'])
    expect(getIpynbCodeCellPreviewLines('one\r\ntwo\r\n')).toEqual(['one', 'two'])
  })

  it('caps newline-heavy cells without splitting or walking the full payload', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const charCodeAt = vi.spyOn(String.prototype, 'charCodeAt')
    const source = '\n'.repeat(100_000)

    expect(getIpynbCodeCellEditorHeight(source, FONT_SIZE)).toBe(520)
    expect(getIpynbCodeCellPreviewLines(source)).toHaveLength(IPYNB_CODE_CELL_PREVIEW_MAX_LINES)

    expect(split).not.toHaveBeenCalled()
    expect(charCodeAt.mock.calls.length).toBeLessThan(300)
  })

  it('bounds long single-line previews and height scans', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const charCodeAt = vi.spyOn(String.prototype, 'charCodeAt')
    const source = 'x'.repeat(IPYNB_CODE_CELL_PREVIEW_SCAN_CODE_UNITS + 10_000)

    expect(getIpynbCodeCellPreviewLines(source)).toEqual([
      'x'.repeat(IPYNB_CODE_CELL_PREVIEW_LINE_MAX_CODE_UNITS)
    ])
    expect(split).not.toHaveBeenCalled()
    expect(charCodeAt.mock.calls.length).toBeLessThanOrEqual(
      IPYNB_CODE_CELL_PREVIEW_SCAN_CODE_UNITS + 1
    )

    charCodeAt.mockClear()
    expect(getIpynbCodeCellEditorHeight(source, FONT_SIZE)).toBe(96)
    expect(charCodeAt.mock.calls.length).toBe(IPYNB_CODE_CELL_EDITOR_HEIGHT_SCAN_CODE_UNITS)
  })
})
