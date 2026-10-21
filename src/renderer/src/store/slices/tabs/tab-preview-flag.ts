// Switch point: main stores a tab's preview flag only while it is true, so a layout-owner build
// writes no `isPreview: false` either; a save carrying one would change the tab in main's model.

import type { Tab } from '../../../../../shared/tab-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'

/** A new tab's preview flag. */
export function createdTabPreviewFlag(isPreview: boolean | undefined): Pick<Tab, 'isPreview'> {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    return { isPreview }
  }
  return isPreview ? { isPreview: true } : {}
}

/** The tab with its preview ended. */
export function withPreviewEnded(tab: Tab): Tab {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    return { ...tab, isPreview: false }
  }
  const { isPreview: _ended, ...rest } = tab
  return rest
}
