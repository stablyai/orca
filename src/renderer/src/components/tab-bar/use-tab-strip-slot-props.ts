import { cn } from '@/lib/class-names'
import { useTabDragActive } from '../tab-group/tab-drag-context'
import {
  TERMINAL_TAB_CONTAINER_WIDTH_CLASSES,
  CONTENT_TAB_CONTAINER_WIDTH_CLASSES
} from './tab-width-rules'

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
