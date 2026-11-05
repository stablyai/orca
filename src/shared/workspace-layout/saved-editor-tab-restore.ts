// Share startup restore filtering between window hydration and main load so neither retains editor tabs the other cannot draw.

import type { Tab, TabContentType } from '../tab-types'

/** Diff, conflict and check tabs: their documents live in memory only and are never saved. */
export function isTransientEditorContentType(contentType: TabContentType): boolean {
  return (
    contentType === 'diff' || contentType === 'conflict-review' || contentType === 'check-details'
  )
}

/** Old HTML previews have no restorable document. Transient tabs return only with a saved edit file or retained view; otherwise their group would point at nothing. */
export function restoresSavedContentTab(
  tab: Pick<Tab, 'contentType' | 'entityId'>,
  savedEditFilePaths: ReadonlySet<string>,
  keepsView: () => boolean
): boolean {
  if (tab.contentType === 'editor' && tab.entityId.startsWith('html-preview::')) {
    return false
  }
  if (!isTransientEditorContentType(tab.contentType)) {
    return true
  }
  return savedEditFilePaths.has(tab.entityId) || keepsView()
}
