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

// Why: the active tab no longer recolors its background, so this 1px top
// border is the ONLY cue distinguishing the selected tab. Absolutely
// positioned with z-10 so it overlays the tab chrome without shifting layout
// and without conflicting with drop-indicator pseudo-elements during a drag.
// `-top-px` pulls it onto the tab's own 1px top border so the blue bar
// REPLACES the faint gray line rather than stacking below it. Horizontal
// inset is 0 (not -1px): negative insets on the last tab bleed into the
// strip's scrollWidth, so clicking between active tabs flips the strip
// between "fits exactly" and "overflows by 1px", which jitters every tab by
// 1px because the browser preserves scrollLeft near the end.
export const ACTIVE_TAB_INDICATOR_CLASSES =
  'pointer-events-none absolute inset-x-0 -top-px h-px bg-[#1e3d9c] z-10'
