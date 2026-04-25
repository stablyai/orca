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

// Why: the bg-accent vs. bg-card contrast alone is too subtle to tell which
// tab is active at a glance, especially in light mode. VS Code solves this
// with a 1–2px colored bar across the top of the active tab
// (tab.activeBorderTop). We mirror that here with an absolutely-positioned
// child span so it sits above the tab content without shifting layout and
// without conflicting with drop-indicator pseudo-elements during a drag.
export const ACTIVE_TAB_INDICATOR_CLASSES =
  'pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-[#1e3d9c] z-10'
