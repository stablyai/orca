// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { cursorTooltipOffsets, splitTrailingSegment } from './file-path-cursor-tooltip'

describe('cursorTooltipOffsets', () => {
  const row = { bottom: 120, left: 400 }

  it('places the tooltip under the cursor rather than the row', () => {
    // Row-anchored placement would be align 0; the cursor is 64px into the row.
    expect(cursorTooltipOffsets({ x: 464, y: 108 }, row)).toEqual({ align: 64, side: 6 })
  })

  it('tracks the cursor across the row', () => {
    const left = cursorTooltipOffsets({ x: 410, y: 108 }, row)
    const right = cursorTooltipOffsets({ x: 610, y: 108 }, row)

    expect(right.align - left.align).toBe(200)
    expect(right.side).toBe(left.side)
  })

  it('stays anchored to the cursor when the row moves under it', () => {
    // The dropdown reflows while results stream in; re-measuring the row must
    // keep the tooltip on the cursor, not drag it along with the row.
    const before = cursorTooltipOffsets({ x: 464, y: 108 }, row)
    const after = cursorTooltipOffsets({ x: 464, y: 108 }, { bottom: 148, left: 576 })

    expect(row.left + before.align).toBe(576 + after.align)
    expect(row.bottom + before.side).toBe(148 + after.side)
  })
})

describe('splitTrailingSegment', () => {
  it('keeps the separator on the directory', () => {
    expect(splitTrailingSegment('app/src/SecondaryNav.tsx')).toEqual({
      directory: 'app/src/',
      filename: 'SecondaryNav.tsx'
    })
  })

  it('does not duplicate the root separator', () => {
    expect(splitTrailingSegment('/foo')).toEqual({ directory: '/', filename: 'foo' })
  })

  it('preserves Windows separators', () => {
    expect(splitTrailingSegment('C:\\repo\\src\\a.ts')).toEqual({
      directory: 'C:\\repo\\src\\',
      filename: 'a.ts'
    })
  })

  it('returns no directory for a bare filename', () => {
    expect(splitTrailingSegment('README.md')).toEqual({ directory: '', filename: 'README.md' })
  })
})
