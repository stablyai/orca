export type DropIndicator = 'left' | 'right' | null

// Why: the theme's accent color is too subtle for a drag-and-drop insertion
// cue. A vivid blue matches VS Code's tab.dragAndDropBorder and is immediately
// visible against all tab backgrounds. Pseudo-elements sit above the tab's
// own border so the indicator does not shift layout.
export function getDropIndicatorClasses(dropIndicator: DropIndicator): string {
  if (dropIndicator === 'left') {
    return "before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:bg-blue-500 before:z-10 before:content-['']"
  }
  if (dropIndicator === 'right') {
    return "after:absolute after:inset-y-0 after:right-0 after:w-[2px] after:bg-blue-500 after:z-10 after:content-['']"
  }
  return ''
}

// Why: a 2px bar on the active tab's BOTTOM edge, bridging the tab into the
// panel it owns. The active tab also lifts its background with a very subtle
// color-mix wash (uniform in light and dark, unlike `accent` whose contrast
// against `card` is lopsided across themes); this bar is the crisp selection
// marker layered on top. Mixing `foreground` with `card` keeps the marker
// neutral and visible without overpowering the quiet tab chrome. z-10 keeps it
// above the bg lift and the
// unread amber wash. Horizontal inset is 0 (not -1px): negative insets on the
// last tab bleed into the strip's scrollWidth, so clicking between active tabs
// flips the strip between "fits exactly" and "overflows by 1px", which jitters
// every tab by 1px because the browser preserves scrollLeft near the end.
export const ACTIVE_TAB_INDICATOR_CLASSES =
  'pointer-events-none absolute inset-x-0 bottom-0 h-[2px] bg-[color-mix(in_srgb,var(--foreground)_60%,var(--card))] z-10'

export function getTabRootStateClasses(isActive: boolean): string {
  return isActive
    ? 'bg-[color-mix(in_srgb,var(--foreground)_6%,var(--card))] text-foreground'
    : 'bg-card text-muted-foreground hover:text-foreground'
}

export function getTabStripBorderClasses(
  hasTabsToRight: boolean,
  options?: { includeTopBorder?: boolean }
): string {
  const includeTopBorder = options?.includeTopBorder ?? true
  return [includeTopBorder ? 'border-t' : '', hasTabsToRight ? 'border-r' : '', 'border-border']
    .filter(Boolean)
    .join(' ')
}
