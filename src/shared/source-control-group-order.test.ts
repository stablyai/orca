import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SOURCE_CONTROL_GROUP_ORDER,
  normalizeSourceControlGroupOrder
} from './source-control-group-order'

describe('normalizeSourceControlGroupOrder', () => {
  it('keeps supported source control group orders', () => {
    expect(normalizeSourceControlGroupOrder('changes-first')).toBe('changes-first')
    expect(normalizeSourceControlGroupOrder('staged-first')).toBe('staged-first')
    expect(normalizeSourceControlGroupOrder('untracked-first')).toBe('untracked-first')
  })

  it('falls back to the default for malformed values', () => {
    expect(normalizeSourceControlGroupOrder('tracked-first')).toBe(
      DEFAULT_SOURCE_CONTROL_GROUP_ORDER
    )
    expect(normalizeSourceControlGroupOrder(undefined)).toBe(DEFAULT_SOURCE_CONTROL_GROUP_ORDER)
  })
})
