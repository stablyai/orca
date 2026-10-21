import { describe, expect, it } from 'vitest'
import {
  MAX_MANUAL_TAG_ORDER,
  getManualTagRanks,
  mergeManualTagOrder,
  normalizeManualTagOrder
} from './manual-tag-order'

describe('normalizeManualTagOrder', () => {
  it('trims, drops blanks, and keeps the first spelling of a repeated tag', () => {
    expect(normalizeManualTagOrder(['  Billing ', '', 'billing', 'UI', 42, null])).toEqual([
      'Billing',
      'UI'
    ])
  })

  it('returns an empty order for anything that is not an array', () => {
    expect(normalizeManualTagOrder(undefined)).toEqual([])
    expect(normalizeManualTagOrder('Billing')).toEqual([])
  })

  it('caps the stored order', () => {
    const tags = Array.from({ length: MAX_MANUAL_TAG_ORDER + 5 }, (_, index) => `tag-${index}`)
    expect(normalizeManualTagOrder(tags)).toHaveLength(MAX_MANUAL_TAG_ORDER)
  })
})

describe('getManualTagRanks', () => {
  it('ranks case-insensitively so one tag has one rank', () => {
    const ranks = getManualTagRanks(['Billing', 'UI'])
    expect(ranks.get('billing')).toBe(0)
    expect(ranks.get('ui')).toBe(1)
    expect(ranks.get('infra')).toBeUndefined()
  })
})

describe('mergeManualTagOrder', () => {
  it('takes the dropped order for visible tags and leaves hidden tags in their slots', () => {
    expect(mergeManualTagOrder(['Alpha', 'Beta', 'Gamma', 'Delta'], ['Delta', 'Beta'])).toEqual([
      'Alpha',
      'Delta',
      'Gamma',
      'Beta'
    ])
  })

  it('reorders the whole list when every tag is visible', () => {
    expect(mergeManualTagOrder(['Billing', 'Infra', 'UI'], ['UI', 'Billing', 'Infra'])).toEqual([
      'UI',
      'Billing',
      'Infra'
    ])
  })

  it('appends tags that were never in the stored order, after the slots it already had', () => {
    expect(mergeManualTagOrder(['Infra'], ['UI', 'Billing'])).toEqual(['Infra', 'UI', 'Billing'])
  })

  it('matches a stored tag to the visible one case-insensitively, without duplicating it', () => {
    expect(mergeManualTagOrder(['billing', 'Infra'], ['Billing'])).toEqual(['Billing', 'Infra'])
  })
})
