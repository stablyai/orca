import { describe, expect, it } from 'vitest'
import {
  RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME,
  RIGHT_SIDEBAR_TOP_ACTIVITY_STRIP_CLASS_NAME,
  RIGHT_SIDEBAR_WINDOWS_TOP_ACTIVITY_STRIP_CLASS_NAME
} from './right-sidebar-titlebar-drag-regions'

describe('right sidebar titlebar drag regions', () => {
  it('keeps the top activity strips from cancelling header window drag', () => {
    expect(RIGHT_SIDEBAR_TOP_ACTIVITY_STRIP_CLASS_NAME).not.toContain(
      RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME
    )
    expect(RIGHT_SIDEBAR_WINDOWS_TOP_ACTIVITY_STRIP_CLASS_NAME).not.toContain(
      RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME
    )
  })

  it('keeps a shared no-drag class for interactive header controls', () => {
    expect(RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME).toBe('right-sidebar-header-no-drag')
  })
})
