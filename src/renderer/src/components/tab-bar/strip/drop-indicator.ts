import type { TabStripOrientation } from './tab-strip-orientation'

/** Before/after the hovered tab: left/right in the strip, above/below in the vertical list. */
export type DropIndicator = 'left' | 'right' | null

// Use a visible blue insertion cue above tab borders without changing layout.
export function getDropIndicatorClasses(
  dropIndicator: DropIndicator,
  orientation: TabStripOrientation = 'horizontal'
): string {
  if (orientation === 'vertical') {
    if (dropIndicator === 'left') {
      return "before:absolute before:inset-x-0 before:top-0 before:h-[2px] before:bg-blue-500 before:z-10 before:content-['']"
    }
    if (dropIndicator === 'right') {
      return "after:absolute after:inset-x-0 after:bottom-0 after:h-[2px] after:bg-blue-500 after:z-10 after:content-['']"
    }
    return ''
  }
  if (dropIndicator === 'left') {
    return "before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:bg-blue-500 before:z-10 before:content-['']"
  }
  if (dropIndicator === 'right') {
    return "after:absolute after:inset-y-0 after:right-0 after:w-[2px] after:bg-blue-500 after:z-10 after:content-['']"
  }
  return ''
}

// Keep the foreground marker above selection/unread layers; zero horizontal inset avoids scrollWidth jitter at the strip’s end.
// Why the tab-group variant: with split groups only the focused group's active tab is accented, else every group reads as focused.
export const ACTIVE_TAB_INDICATOR_CLASSES =
  'pointer-events-none absolute inset-x-0 bottom-0 h-[2px] bg-tab-active-indicator z-20 group-data-[single-tab]/tab-strip:hidden group-data-[unfocused-split-group]/tab-group:hidden'

// The vertical list marks the active row on its leading edge, as the strip marks the bottom.
const VERTICAL_ACTIVE_TAB_INDICATOR_CLASSES =
  'pointer-events-none absolute inset-y-1 left-0 w-[2px] rounded-full bg-tab-active-indicator z-20 group-data-[unfocused-split-group]/tab-group:hidden'

export function getActiveTabIndicatorClasses(orientation: TabStripOrientation): string {
  return orientation === 'vertical'
    ? VERTICAL_ACTIVE_TAB_INDICATOR_CLASSES
    : ACTIVE_TAB_INDICATOR_CLASSES
}

export function getTabRootStateClasses(
  isActive: boolean,
  orientation: TabStripOrientation = 'horizontal'
): string {
  // List rows sit on the list's own ground, highlighted like sidebar rows rather than raised like strip tabs.
  if (orientation === 'vertical') {
    return isActive
      ? 'bg-accent text-accent-foreground'
      : 'bg-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground'
  }
  return isActive
    ? 'bg-tab-active text-tab-active-foreground'
    : 'bg-tab-inactive text-tab-inactive-foreground hover:text-tab-active-foreground'
}

export function getTabStripBorderClasses(
  hasTabsToRight: boolean,
  options?: { includeTopBorder?: boolean; orientation?: TabStripOrientation }
): string {
  // Rows in the vertical list are separated by their own backgrounds, like Chrome's side tabs.
  if (options?.orientation === 'vertical') {
    return 'rounded-sm'
  }
  const includeTopBorder = options?.includeTopBorder ?? true
  return [
    includeTopBorder ? 'border-t' : '',
    'border-r border-border',
    hasTabsToRight ? '' : 'border-r-transparent'
  ]
    .filter(Boolean)
    .join(' ')
}
