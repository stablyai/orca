import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FLUSH_CARD_CONTENT_PULLBACK,
  DEFAULT_SIDEBAR_SECTION_HEADER_ROW_HEIGHT,
  LARGER_FLUSH_CARD_CONTENT_PULLBACK,
  LARGER_SIDEBAR_SECTION_HEADER_ROW_HEIGHT,
  getSidebarSectionHeaderTitleClassName,
  resolveSidebarSectionHeaderAppearance
} from './sidebar-section-header-appearance'

describe('sidebar section header appearance', () => {
  it('keeps the legacy sidebar section sizing off by default', () => {
    expect(resolveSidebarSectionHeaderAppearance(null)).toEqual({
      enabled: false,
      headerRowHeight: DEFAULT_SIDEBAR_SECTION_HEADER_ROW_HEIGHT,
      flushCardContentPullback: DEFAULT_FLUSH_CARD_CONTENT_PULLBACK,
      revealTopInset: DEFAULT_SIDEBAR_SECTION_HEADER_ROW_HEIGHT + 6
    })
  })

  it('enables the larger sidebar section treatment when the experimental flag is on', () => {
    expect(
      resolveSidebarSectionHeaderAppearance({ experimentalLargerSidebarSections: true })
    ).toEqual({
      enabled: true,
      headerRowHeight: LARGER_SIDEBAR_SECTION_HEADER_ROW_HEIGHT,
      flushCardContentPullback: LARGER_FLUSH_CARD_CONTENT_PULLBACK,
      revealTopInset: LARGER_SIDEBAR_SECTION_HEADER_ROW_HEIGHT + 6
    })
  })

  it('uses the larger title class only when the experimental flag is on', () => {
    expect(getSidebarSectionHeaderTitleClassName(false)).toContain('text-[13px]')
    expect(getSidebarSectionHeaderTitleClassName(true)).toContain('text-sm')
  })
})
