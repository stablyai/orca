/** Marks the filename text, which doubles as the double-click-to-rename hotspot. */
export const RENAME_HOTSPOT_ATTR = 'data-file-explorer-row-name'

export type DirToggleTiming = 'immediate' | 'skip'

export function isRenameHotspotTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${RENAME_HOTSPOT_ATTR}]`) !== null
}

/**
 * Why: a double-click on the filename used to toggle the directory twice before
 * the rename started, so the row visibly collapsed and re-expanded. The first
 * click toggles instantly (a delay here reads as lag next to the chevron); only
 * the second click of a double-click on the rename hotspot drops its toggle so
 * the folder doesn't flip back under the rename input.
 */
export function resolveDirToggleTiming({
  fromRenameHotspot,
  clickCount
}: {
  fromRenameHotspot: boolean
  clickCount: number
}): DirToggleTiming {
  return fromRenameHotspot && clickCount > 1 ? 'skip' : 'immediate'
}
