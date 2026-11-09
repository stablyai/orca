import { TAB_STRIP_ORIENTATION, type TabStripOrientation } from './tab-strip-orientation'

/** `left` is before the tab and `right` after it in tab order, also when the strip runs vertically. */
export type DropIndicator = 'left' | 'right' | null

// Use a visible blue insertion cue above tab borders without changing layout.
export function getDropIndicatorClasses(
  dropIndicator: DropIndicator,
  orientation: TabStripOrientation = TAB_STRIP_ORIENTATION.horizontal
): string {
  if (orientation === TAB_STRIP_ORIENTATION.vertical) {
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
export const ACTIVE_TAB_INDICATOR_CLASSES =
  'pointer-events-none absolute inset-x-0 bottom-0 h-[2px] bg-tab-active-indicator z-20 group-data-[single-tab]/tab-strip:hidden'

export function getActiveTabIndicatorClasses(orientation: TabStripOrientation): string {
  return orientation === TAB_STRIP_ORIENTATION.vertical
    ? 'pointer-events-none absolute inset-y-0 left-0 w-[2px] bg-tab-active-indicator z-20 group-data-[single-tab]/tab-strip:hidden'
    : ACTIVE_TAB_INDICATOR_CLASSES
}

export function getTabRootStateClasses(isActive: boolean): string {
  return isActive
    ? 'bg-tab-active text-tab-active-foreground'
    : 'bg-tab-inactive text-tab-inactive-foreground hover:text-tab-active-foreground'
}

export function getTabStripBorderClasses(
  hasTabsToRight: boolean,
  options?: { includeTopBorder?: boolean; orientation?: TabStripOrientation }
): string {
  if (options?.orientation === TAB_STRIP_ORIENTATION.vertical) {
    return 'border-b border-border'
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
