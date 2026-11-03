import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { useTabDragActive } from '../tab-group/tab-drag-context'
import { TAB_CONTAINER_WIDTH_CLASSES } from './tab-width-rules'

type TabStripSlotProps = {
  className: string
  'data-tab-strip-slot': string
  'data-active-tab-dock': '' | undefined
}

/** Dock the active slot at viewport edges except during drag, when overlapping rects would corrupt drop targets. */
export function useTabStripSlotProps(tabId: string, isActive: boolean): TabStripSlotProps {
  const isTabDragActive = useTabDragActive()
  // A user-sized tab keeps its width; TabStripSlotResizeHandle writes the width itself.
  const hasStoredWidth = useAppStore((s) => s.tabWidthsById[tabId] !== undefined)
  const docks = isActive && !isTabDragActive
  return {
    className: cn(
      TAB_CONTAINER_WIDTH_CLASSES,
      'relative',
      hasStoredWidth && 'flex-none',
      docks && 'sticky inset-x-0 z-10'
    ),
    'data-tab-strip-slot': tabId,
    'data-active-tab-dock': docks ? '' : undefined
  }
}
