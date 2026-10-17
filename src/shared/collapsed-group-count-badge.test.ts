import { describe, expect, it } from 'vitest'
import {
  collapsedGroupCountBadgeNeedsAttention,
  DEFAULT_COLLAPSED_GROUP_COUNT_BADGE_MODE,
  resolveCollapsedGroupCountBadgeMode
} from './collapsed-group-count-badge'

describe('resolveCollapsedGroupCountBadgeMode', () => {
  it('defaults to off for profiles predating the setting', () => {
    expect(resolveCollapsedGroupCountBadgeMode(undefined)).toBe('off')
    expect(resolveCollapsedGroupCountBadgeMode(null)).toBe('off')
    expect(resolveCollapsedGroupCountBadgeMode({})).toBe('off')
  })

  it('ships off as the app default', () => {
    expect(DEFAULT_COLLAPSED_GROUP_COUNT_BADGE_MODE).toBe('off')
  })

  it('keeps every valid mode', () => {
    expect(resolveCollapsedGroupCountBadgeMode({ collapsedGroupCountBadge: 'attention' })).toBe(
      'attention'
    )
    expect(resolveCollapsedGroupCountBadgeMode({ collapsedGroupCountBadge: 'all' })).toBe('all')
  })

  it('falls back for a value outside the union', () => {
    expect(
      resolveCollapsedGroupCountBadgeMode({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a persisted profile can carry a value outside the union; the test feeds one on purpose.
        collapsedGroupCountBadge: 'everything' as never
      })
    ).toBe('off')
  })

  it('needs the attention tally in every mode but off', () => {
    expect(collapsedGroupCountBadgeNeedsAttention('off')).toBe(false)
    expect(collapsedGroupCountBadgeNeedsAttention('attention')).toBe(true)
    expect(collapsedGroupCountBadgeNeedsAttention('all')).toBe(true)
  })
})
