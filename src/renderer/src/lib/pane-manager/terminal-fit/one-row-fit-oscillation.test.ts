import { describe, expect, it } from 'vitest'
import {
  isEchoOfLastRowFlip,
  rowFlipToRemember,
  type AppliedRowFlip
} from './one-row-fit-oscillation'

const flip = (fromRows: number, toRows: number, cols = 138): AppliedRowFlip => ({
  cols,
  fromRows,
  toRows
})

describe('rowFlipToRemember', () => {
  it('remembers a one-row change with the same column count', () => {
    expect(rowFlipToRemember({ cols: 138, rows: 50 }, { cols: 138, rows: 49 })).toEqual(
      flip(50, 49)
    )
  })

  it('ignores a stable grid, a multi-row jump, and a column change', () => {
    expect(rowFlipToRemember({ cols: 138, rows: 50 }, { cols: 138, rows: 50 })).toBeNull()
    expect(rowFlipToRemember({ cols: 138, rows: 50 }, { cols: 138, rows: 48 })).toBeNull()
    expect(rowFlipToRemember({ cols: 138, rows: 50 }, { cols: 140, rows: 49 })).toBeNull()
  })
})

describe('isEchoOfLastRowFlip', () => {
  it('recognises the reverse of the flip just applied', () => {
    expect(
      isEchoOfLastRowFlip(flip(50, 49), { cols: 138, rows: 49 }, { cols: 138, rows: 50 })
    ).toBe(true)
  })

  it('does not treat a new one-row step, or the same direction, as an echo', () => {
    expect(
      isEchoOfLastRowFlip(flip(50, 49), { cols: 138, rows: 49 }, { cols: 138, rows: 48 })
    ).toBe(false)
    expect(
      isEchoOfLastRowFlip(flip(50, 49), { cols: 138, rows: 50 }, { cols: 138, rows: 49 })
    ).toBe(false)
    expect(isEchoOfLastRowFlip(undefined, { cols: 138, rows: 49 }, { cols: 138, rows: 50 })).toBe(
      false
    )
  })
})
