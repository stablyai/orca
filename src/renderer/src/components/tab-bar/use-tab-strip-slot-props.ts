import { cn } from '@/lib/utils'
import { useTabDragActive } from '../tab-group/tab-drag-context'
import {
  TAB_CONTAINER_FIT_WIDTH_CLASSES,
  TAB_CONTAINER_FIXED_WIDTH_CLASSES,
  useFitsTabsToTitles
} from './tab-width-rules'

type TabStripSlotProps = {
  className: string
  'data-tab-strip-slot': string
  'data-active-tab-dock': '' | undefined
}

/** Dock the active slot at viewport edges except during drag, when overlapping rects would corrupt drop targets. */
export function useTabStripSlotProps(tabId: string, isActive: boolean): TabStripSlotProps {
  const isTabDragActive = useTabDragActive()
  const docks = isActive && !isTabDragActive
  const widthClasses = useFitsTabsToTitles()
    ? TAB_CONTAINER_FIT_WIDTH_CLASSES
    : TAB_CONTAINER_FIXED_WIDTH_CLASSES
  return {
    className: cn(widthClasses, docks && 'sticky inset-x-0 z-10'),
    'data-tab-strip-slot': tabId,
    'data-active-tab-dock': docks ? '' : undefined
  }
}
