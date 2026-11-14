import type { CSSProperties } from 'react'
import { cn } from '@/lib/class-names'
import { useAppStore } from '@/store'
import { normalizeTabSizing } from '../../../../shared/tab-sizing'
import { useTabDragActive } from '../tab-group/tab-drag-context'
import {
  getTabContainerWidthClasses,
  getTabContainerWidthStyle,
  TAB_RENAME_WIDTH_CLASSES,
  type TabStripSlotSizing
} from './tab-width-rules'

type TabStripSlotProps = {
  className: string
  style: CSSProperties
  'data-tab-strip-slot': string
  'data-active-tab-dock': '' | undefined
}

/** Dock the active slot at viewport edges except during drag, when overlapping rects would corrupt drop targets. */
export function useTabStripSlotProps(
  tabId: string,
  isActive: boolean,
  sizing: TabStripSlotSizing = 'content'
): TabStripSlotProps {
  const isTabDragActive = useTabDragActive()
  const tabSizingMode = useAppStore((s) => s.settings?.tabSizing)
  const tabSizingMinWidth = useAppStore((s) => s.settings?.tabSizingMinWidth)
  const tabSizingMaxWidth = useAppStore((s) => s.settings?.tabSizingMaxWidth)
  const tabSizing = normalizeTabSizing({
    tabSizing: tabSizingMode,
    tabSizingMinWidth,
    tabSizingMaxWidth
  })
  const docks = isActive && !isTabDragActive
  return {
    className: cn(
      getTabContainerWidthClasses(tabSizing.mode, sizing),
      TAB_RENAME_WIDTH_CLASSES,
      docks && 'sticky inset-x-0 z-10'
    ),
    style: getTabContainerWidthStyle(tabSizing),
    'data-tab-strip-slot': tabId,
    'data-active-tab-dock': docks ? '' : undefined
  }
}
