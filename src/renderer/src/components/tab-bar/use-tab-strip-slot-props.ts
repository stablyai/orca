import { cn } from '@/lib/utils'
import { useTabDragActive } from '../tab-group/tab-drag-context'
import { TAB_CONTAINER_WIDTH_CLASSES } from './tab-width-rules'

type TabStripSlotProps = {
  className: string
  'data-tab-strip-slot': string
  'data-active-tab-dock': '' | undefined
}

/**
 * Props for a tab's direct child of the strip. The active one is sticky so it docks to the edge
 * instead of scrolling out of view. Why not during a drag: drop targets come from on-screen
 * rects, and a docked tab overlaps its neighbour.
 */
export function useTabStripSlotProps(tabId: string, isActive: boolean): TabStripSlotProps {
  const isTabDragActive = useTabDragActive()
  const docks = isActive && !isTabDragActive
  return {
    className: cn(TAB_CONTAINER_WIDTH_CLASSES, docks && 'sticky inset-x-0 z-10'),
    'data-tab-strip-slot': tabId,
    'data-active-tab-dock': docks ? '' : undefined
  }
}
