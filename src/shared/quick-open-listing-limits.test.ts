import { describe, expect, it } from 'vitest'
import {
  resolveQuickOpenResultLimit,
  QUICK_OPEN_LISTING_MAX_RESULTS
} from './quick-open-listing-limits'

describe('Quick Open listing limits', () => {
  it('uses one hard result cap while preserving smaller requested limits', () => {
    expect(resolveQuickOpenResultLimit()).toBe(QUICK_OPEN_LISTING_MAX_RESULTS)
    expect(resolveQuickOpenResultLimit(17)).toBe(17)
    expect(resolveQuickOpenResultLimit(QUICK_OPEN_LISTING_MAX_RESULTS + 1)).toBe(
      QUICK_OPEN_LISTING_MAX_RESULTS
    )
    expect(resolveQuickOpenResultLimit(0)).toBe(0)
  })
})
