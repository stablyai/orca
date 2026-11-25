import { cn } from '@/lib/class-names'
import { useTabDragActive } from '../../tab-group/drag/tab-drag-context'
import {
  TERMINAL_TAB_CONTAINER_WIDTH_CLASSES,
  CONTENT_TAB_CONTAINER_WIDTH_CLASSES,
  VERTICAL_TAB_ROW_CLASSES
} from './tab-width-rules'
import { useTabStripOrientation } from './tab-strip-orientation'

type TabStripSlotProps = {
  className: string
  'data-tab-strip-slot': string
  'data-active-tab-dock': '' | undefined
}

/** Dock the active slot at viewport edges except during drag, when overlapping rects would corrupt drop targets. */
export function useTabStripSlotProps(
  tabId: string,
  isActive: boolean,
  sizing: 'content' | 'terminal' = 'content'
): TabStripSlotProps {
  const isTabDragActive = useTabDragActive()
  const orientation = useTabStripOrientation()
  if (orientation === 'vertical') {
    // Fixed-height rows: the list windows them by index, and the active row scrolls into view instead of docking.
    return {
      className: VERTICAL_TAB_ROW_CLASSES,
      'data-tab-strip-slot': tabId,
      'data-active-tab-dock': undefined
    }
  }
  const docks = isActive && !isTabDragActive
  return {
    className: cn(
      sizing === 'terminal'
        ? TERMINAL_TAB_CONTAINER_WIDTH_CLASSES
        : CONTENT_TAB_CONTAINER_WIDTH_CLASSES,
      // Reserve a stable editing width without measuring or storing layout in React.
      'has-[[data-tab-rename-input]]:w-[300px] has-[[data-tab-rename-input]]:flex-none',
      docks && 'sticky inset-x-0 z-10'
    ),
    'data-tab-strip-slot': tabId,
    'data-active-tab-dock': docks ? '' : undefined
  }
}
