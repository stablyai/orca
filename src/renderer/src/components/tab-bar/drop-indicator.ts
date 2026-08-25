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
// panel it owns — the crisp selection marker layered on top of the lifted
// background. `ring` is the documented token for "active selection halos"
// (STYLEGUIDE.md), and unlike a `foreground`/`card` mix it's a fixed
// per-theme gray, so it can't flip direction between light and dark (#16283).
// z-10 keeps it above the bg lift and the unread amber wash. Horizontal inset
// is 0 (not -1px): negative insets on the last tab bleed into the strip's
// scrollWidth, so clicking between active tabs flips the strip between "fits
// exactly" and "overflows by 1px", which jitters every tab by 1px because the
// browser preserves scrollLeft near the end.
export const ACTIVE_TAB_INDICATOR_CLASSES =
  'pointer-events-none absolute inset-x-0 bottom-0 h-[2px] bg-ring z-10'

// Why: `--tab-strip-active/inactive-surface` (main.css) swap which side gets
// the foreground/card mix per theme so the active tab always reads lighter
// than the inactive one — `--card` is already max-lightness in light mode,
// so the mix has to darken the inactive tab there instead of lightening the
// active one like it does in dark mode (#16283).
export function getTabRootStateClasses(isActive: boolean): string {
  return isActive
    ? 'bg-[var(--tab-strip-active-surface)] text-foreground'
    : 'bg-[var(--tab-strip-inactive-surface)] text-muted-foreground hover:text-foreground'
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
