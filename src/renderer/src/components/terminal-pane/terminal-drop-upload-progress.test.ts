import { describe, expect, it } from 'vitest'
import { formatTransferredOfTotal, toPercent, toRowPercent } from './terminal-drop-upload-progress'

const MB = 1024 * 1024

describe('formatTransferredOfTotal', () => {
  it('scales both figures to the total unit', () => {
    expect(formatTransferredOfTotal(8.63 * MB, 32.5 * MB)).toBe('8.6 / 32.5 MB')
  })

  it('keeps the smaller figure on the total scale instead of its own', () => {
    // 900 KB of 32.5 MB must not render as "900 / 32.5".
    expect(formatTransferredOfTotal(900 * 1024, 32.5 * MB)).toBe('0.9 / 32.5 MB')
  })

  it('uses whole bytes without decimals', () => {
    expect(formatTransferredOfTotal(120, 900)).toBe('120 / 900 B')
  })

  it('drops to no decimals once the total is large in its unit', () => {
    expect(formatTransferredOfTotal(150 * MB, 300 * MB)).toBe('150 / 300 MB')
  })

  it('never shows more sent than the total', () => {
    expect(formatTransferredOfTotal(50 * MB, 10 * MB)).toBe('10.0 / 10.0 MB')
  })

  it('handles a zero-byte drop without dividing by zero', () => {
    expect(formatTransferredOfTotal(0, 0)).toBe('0 B')
  })
})

describe('toRowPercent', () => {
  it('reads 100 for a finished row with nothing to move', () => {
    expect(toRowPercent({ status: 'done', sentBytes: 0, totalBytes: 0 })).toBe(100)
  })

  it('stays at 0 for an empty row still in flight', () => {
    expect(toRowPercent({ status: 'uploading', sentBytes: 0, totalBytes: 0 })).toBe(0)
  })

  it('follows the bytes for a row with content', () => {
    expect(toRowPercent({ status: 'uploading', sentBytes: 25, totalBytes: 100 })).toBe(25)
  })
})

describe('toPercent', () => {
  it('floors so it only reads 100 when everything landed', () => {
    expect(toPercent(999_999, 1_000_000)).toBe(99)
    expect(toPercent(1_000_000, 1_000_000)).toBe(100)
  })

  it('is zero when nothing is measurable', () => {
    expect(toPercent(0, 0)).toBe(0)
  })

  it('clamps a source that grew past its staged size', () => {
    expect(toPercent(200, 100)).toBe(100)
  })
})
