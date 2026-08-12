import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FILE_EXPLORER_FONT_SIZE,
  clampFileExplorerFontSize,
  fileExplorerRowHeightPx
} from './file-explorer-font-size'

describe('clampFileExplorerFontSize', () => {
  it('clamps to the supported range', () => {
    expect(clampFileExplorerFontSize(9)).toBe(10)
    expect(clampFileExplorerFontSize(21)).toBe(20)
    expect(clampFileExplorerFontSize(14.6)).toBe(15)
  })

  it('falls back for non-finite values', () => {
    expect(clampFileExplorerFontSize(Number.NaN)).toBe(DEFAULT_FILE_EXPLORER_FONT_SIZE)
  })
})

describe('fileExplorerRowHeightPx', () => {
  it('keeps the historical 26px row at the default 12px font', () => {
    expect(fileExplorerRowHeightPx(12)).toBe(26)
  })
})
