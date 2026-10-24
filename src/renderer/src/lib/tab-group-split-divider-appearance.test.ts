import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_TAB_GROUP_SPLIT_DIVIDER_DARK } from '../../../shared/tab-group-split-divider'
import {
  applyTabGroupSplitDividerAppearance,
  resolveTabGroupSplitDividerAppearance
} from './tab-group-split-divider-appearance'

describe('tab-group split divider appearance', () => {
  it('uses the dark workspace setting when the document is dark', () => {
    expect(
      resolveTabGroupSplitDividerAppearance(
        {
          tabGroupSplitDividerColorDark: '#171717',
          tabGroupSplitDividerColorLight: '#cccccc'
        },
        true
      )
    ).toBe('#171717')
  })

  it('uses the light workspace setting when the document is light', () => {
    expect(
      resolveTabGroupSplitDividerAppearance(
        {
          tabGroupSplitDividerColorDark: '#171717',
          tabGroupSplitDividerColorLight: '#cccccc'
        },
        false
      )
    ).toBe('#cccccc')
  })

  it('writes the resolved color onto the document token', () => {
    const setProperty = vi.fn()
    applyTabGroupSplitDividerAppearance(
      { style: { setProperty } },
      {
        tabGroupSplitDividerColorDark: '#171717',
        tabGroupSplitDividerColorLight: '#cccccc'
      },
      true
    )
    expect(setProperty).toHaveBeenCalledWith('--tab-group-split-divider', '#171717')
  })

  it('falls back to the shipped dark token when settings are missing', () => {
    expect(resolveTabGroupSplitDividerAppearance(null, true)).toBe(
      DEFAULT_TAB_GROUP_SPLIT_DIVIDER_DARK
    )
  })
})
