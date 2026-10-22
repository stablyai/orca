// Which saved editor-family tabs a restore brings back. One rule for the window's hydration and
// main's layout load, so both drop the same tabs and neither holds a tab the other cannot draw.

import type { Tab, TabContentType } from '../tab-types'

/** Diff, conflict and check tabs: their documents live in memory only and are never saved. */
export function isTransientEditorContentType(contentType: TabContentType): boolean {
  return (
    contentType === 'diff' || contentType === 'conflict-review' || contentType === 'check-details'
  )
}

/**
 * Whether a saved non-terminal tab comes back. An old html preview's tab names a document no restore
 * produces (a preview is a browser tab now, and re-deriving its document from the id is guesswork).
 * A transient tab's document is never saved, so it comes back only for a saved edit file of its
 * entity, or while its view is still held (`keepsView`); else its group would point at nothing.
 */
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
