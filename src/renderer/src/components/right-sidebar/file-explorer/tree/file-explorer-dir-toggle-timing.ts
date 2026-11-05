/** Marks the filename text, which doubles as the double-click-to-rename hotspot. */
export const RENAME_HOTSPOT_ATTR = 'data-file-explorer-row-name'

export type DirToggleTiming = 'immediate' | 'skip'

export function isRenameHotspotTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${RENAME_HOTSPOT_ATTR}]`) !== null
}

/** Toggle instantly on first click; skip the filename double-click's second toggle so rename does not flip the folder back. */
export function resolveDirToggleTiming({
  fromRenameHotspot,
  clickCount
}: {
  fromRenameHotspot: boolean
  clickCount: number
}): DirToggleTiming {
  return fromRenameHotspot && clickCount > 1 ? 'skip' : 'immediate'
}
