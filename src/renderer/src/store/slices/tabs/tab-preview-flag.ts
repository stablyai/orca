// Main stores isPreview only when true; frame-owned saves must omit false or mutate main’s model.

import type { Tab } from '../../../../../shared/tab-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'

export function createdTabPreviewFlag(isPreview: boolean | undefined): Pick<Tab, 'isPreview'> {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    return { isPreview }
  }
  return isPreview ? { isPreview: true } : {}
}

export function withPreviewEnded(tab: Tab): Tab {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    return { ...tab, isPreview: false }
  }
  const { isPreview: _ended, ...rest } = tab
  return rest
}
