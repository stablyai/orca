import { describe, expect, it } from 'vitest'
import {
  REVIEW_ACTION_MERGE_BUTTON_CLASS,
  RIGHT_SIDEBAR_MERGE_PRIMARY_BUTTON_CLASS,
  RIGHT_SIDEBAR_MORPHING_PRIMARY_BUTTON_CLASS,
  RIGHT_SIDEBAR_SPLIT_ACTION_ROW_CLASS
} from './right-sidebar-primary-action-layout'

describe('right sidebar primary action layout classes', () => {
  it('fills the sidebar row while stretching wrapped and direct primary buttons', () => {
    expect(RIGHT_SIDEBAR_SPLIT_ACTION_ROW_CLASS).toContain('flex')
    expect(RIGHT_SIDEBAR_SPLIT_ACTION_ROW_CLASS).toContain('w-full')
    expect(RIGHT_SIDEBAR_SPLIT_ACTION_ROW_CLASS).toContain('[&>*:first-child]:flex-1')
    expect(RIGHT_SIDEBAR_SPLIT_ACTION_ROW_CLASS).toContain('[&>*:first-child>button]:w-full')
    expect(RIGHT_SIDEBAR_SPLIT_ACTION_ROW_CLASS).toContain('[&>button:first-child]:w-full')
  })

  it('lets split-button primaries shrink inside the minimum-width sidebar', () => {
    expect(RIGHT_SIDEBAR_SPLIT_ACTION_ROW_CLASS).toContain('min-w-0')
    expect(RIGHT_SIDEBAR_MORPHING_PRIMARY_BUTTON_CLASS).toContain('shrink')
    expect(RIGHT_SIDEBAR_MERGE_PRIMARY_BUTTON_CLASS).toContain('shrink')
  })

  it('uses preferred widths instead of hard minimums for morphing action labels', () => {
    expect(RIGHT_SIDEBAR_MORPHING_PRIMARY_BUTTON_CLASS).toContain('w-[10.5rem]')
    expect(RIGHT_SIDEBAR_MORPHING_PRIMARY_BUTTON_CLASS).not.toContain('min-w-[10.5rem]')
    expect(RIGHT_SIDEBAR_MERGE_PRIMARY_BUTTON_CLASS).toContain('w-[11.5rem]')
    expect(RIGHT_SIDEBAR_MERGE_PRIMARY_BUTTON_CLASS).not.toContain('min-w-[11.5rem]')
  })

  it('shares the shrinkable merge sizing with full-page review actions', () => {
    expect(REVIEW_ACTION_MERGE_BUTTON_CLASS).toBe(RIGHT_SIDEBAR_MERGE_PRIMARY_BUTTON_CLASS)
  })
})
