import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { useTabDragActive } from '../tab-group/tab-drag-context'
import {
  TERMINAL_TAB_CONTAINER_WIDTH_CLASSES,
  CONTENT_TAB_CONTAINER_WIDTH_CLASSES
} from './tab-width-rules'

type TabStripSlotProps = {
  className: string
  'data-tab-strip-slot': string
  'data-active-tab-dock'?: ''
}

// User-sized and resizing slots take their inline width beyond the default 300px cap.
const SIZED_SLOT_CLASSES = 'flex-none max-w-none [&>*]:max-w-none'
const RESIZING_SLOT_CLASSES =
  'data-[tab-resizing]:flex-none data-[tab-resizing]:max-w-none data-[tab-resizing]:[&>*]:max-w-none'

/** Dock the active slot at viewport edges except during drag, when overlapping rects would corrupt drop targets. */
export function useTabStripSlotProps(
  tabId: string,
  isActive: boolean,
  sizing: 'content' | 'terminal' = 'content'
): TabStripSlotProps {
  const isTabDragActive = useTabDragActive()
  // TabStripSlotResizeHandle writes a user-sized tab's width itself.
  const hasStoredWidth = useAppStore((s) => s.tabWidthsById[tabId] !== undefined)
  const docks = isActive && !isTabDragActive
  return {
    className: cn(
      sizing === 'terminal'
        ? TERMINAL_TAB_CONTAINER_WIDTH_CLASSES
        : CONTENT_TAB_CONTAINER_WIDTH_CLASSES,
      'relative',
      // Reserve a stable editing width without measuring or storing layout in React.
      !hasStoredWidth &&
        'has-[[data-tab-rename-input]]:w-[300px] has-[[data-tab-rename-input]]:flex-none',
      hasStoredWidth ? SIZED_SLOT_CLASSES : RESIZING_SLOT_CLASSES,
      docks && 'sticky inset-x-0 z-10'
    ),
    'data-tab-strip-slot': tabId,
    'data-active-tab-dock': docks ? '' : undefined
  }
}
