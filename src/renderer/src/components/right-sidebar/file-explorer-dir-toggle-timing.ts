/** Marks the filename text, which doubles as the double-click-to-rename hotspot. */
export const RENAME_HOTSPOT_ATTR = 'data-file-explorer-row-name'

/**
 * Matches Chromium/Electron's double-click window (`kDoubleClickTimeMS`), so a
 * deferred toggle can't fire before the second click of a slow double-click
 * arrives and turns the gesture into a rename.
 */
export const DIR_TOGGLE_DOUBLE_CLICK_MS = 500

export type DirToggleTiming = 'immediate' | 'deferred' | 'skip'

export function isRenameHotspotTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${RENAME_HOTSPOT_ATTR}]`) !== null
}

/**
 * Why: a double-click on the filename toggles the directory twice before the
 * rename starts, so the row visibly collapses and re-expands. Clicks on the
 * rename hotspot wait out the double-click window; the second click drops the
 * toggle entirely and lets the rename take over.
 */
export function resolveDirToggleTiming({
  fromRenameHotspot,
  clickCount
}: {
  fromRenameHotspot: boolean
  clickCount: number
}): DirToggleTiming {
  if (!fromRenameHotspot) {
    return 'immediate'
  }
  return clickCount > 1 ? 'skip' : 'deferred'
}
