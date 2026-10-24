import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TAB_GROUP_SPLIT_DIVIDER_DARK,
  resolveTabGroupSplitDividerColor
} from './tab-group-split-divider'

describe('resolveTabGroupSplitDividerColor', () => {
  it('keeps a valid hash color', () => {
    expect(resolveTabGroupSplitDividerColor('#171717', DEFAULT_TAB_GROUP_SPLIT_DIVIDER_DARK)).toBe(
      '#171717'
    )
  })

  it('prefixes a valid hashless hex color', () => {
    expect(resolveTabGroupSplitDividerColor('171717', DEFAULT_TAB_GROUP_SPLIT_DIVIDER_DARK)).toBe(
      '#171717'
    )
  })

  it('falls back for empty or invalid values', () => {
    expect(resolveTabGroupSplitDividerColor(undefined, DEFAULT_TAB_GROUP_SPLIT_DIVIDER_DARK)).toBe(
      DEFAULT_TAB_GROUP_SPLIT_DIVIDER_DARK
    )
    expect(resolveTabGroupSplitDividerColor('  ', DEFAULT_TAB_GROUP_SPLIT_DIVIDER_DARK)).toBe(
      DEFAULT_TAB_GROUP_SPLIT_DIVIDER_DARK
    )
    expect(
      resolveTabGroupSplitDividerColor('not-a-color', DEFAULT_TAB_GROUP_SPLIT_DIVIDER_DARK)
    ).toBe(DEFAULT_TAB_GROUP_SPLIT_DIVIDER_DARK)
  })
})
