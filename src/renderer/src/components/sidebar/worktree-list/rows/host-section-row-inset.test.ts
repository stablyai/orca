import { describe, expect, it } from 'vitest'
import { getHostSectionRowInset } from './indentation'

describe('getHostSectionRowInset', () => {
  it.each([
    ['host-header', 2, 2, 0],
    ['header', 1, 2, 0],
    ['item', 1, 2, 0],
    ['header', 3, -1, 0],
    ['header', 3, 2, 18],
    ['item', 4, 2, 36]
  ])(
    '%s at %i with first host at %i is inset %ipx',
    (rowType, index, firstHostHeaderIndex, inset) => {
      expect(getHostSectionRowInset({ rowType, index, firstHostHeaderIndex })).toBe(inset)
    }
  )
})
