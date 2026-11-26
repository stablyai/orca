import { describe, expect, it } from 'vitest'
import { getSearchMatchPreviewParts } from './search-match-preview'

function preview(lineContent: string, needle: string) {
  const column = lineContent.indexOf(needle) + 1
  return getSearchMatchPreviewParts({ line: 1, column, matchLength: needle.length, lineContent })
}

describe('getSearchMatchPreviewParts', () => {
  it('keeps the trimmed line start when it fits', () => {
    expect(preview('    export const useCartStore = 1', 'Cart')).toEqual({
      before: 'export const use',
      match: 'Cart',
      after: 'Store = 1'
    })
  })

  it('opens long prefixes on a word boundary after an ellipsis', () => {
    expect(preview('export const STRING_007_1 = translate(key.cart)', 'cart')).toEqual({
      before: '…key.',
      match: 'cart',
      after: ')'
    })
    expect(preview('const totalWithShippingAndTax = computeCartTotal()', 'Cart').before).toBe(
      '…compute'
    )
  })
})
