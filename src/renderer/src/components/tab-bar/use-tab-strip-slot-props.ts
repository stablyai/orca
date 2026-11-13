import { useContext } from 'react'
import { cn } from '@/lib/class-names'
import { useTabDragActive } from '../tab-group/tab-drag-context'
import {
  TERMINAL_TAB_CONTAINER_WIDTH_CLASSES,
  CONTENT_TAB_CONTAINER_WIDTH_CLASSES
} from './tab-width-rules'
import { TabStripDensityContext } from './tab-strip-density-context'
import { TAB_ICON_ONLY_WIDTH_PX } from './tab-strip-width-budget'

type TabStripSlotProps = {
  className: string
  style: React.CSSProperties | undefined
  'data-tab-strip-slot': string
  'data-active-tab-dock': '' | undefined
  'data-tab-density': 'icon' | undefined
}

/** Dock the active slot at viewport edges except during drag, when overlapping rects would corrupt drop targets. */
export function useTabStripSlotProps(
  tabId: string,
  isActive: boolean,
  sizing: 'content' | 'terminal' = 'content'
): TabStripSlotProps {
  const isTabDragActive = useTabDragActive()
  const density = useContext(TabStripDensityContext)
  const docks = isActive && !isTabDragActive
  const heldWidth = density.heldWidths?.get(tabId)
  const iconOnly = density.iconIds.has(tabId)
  const fixedWidth =
    heldWidth !== undefined
      ? `${heldWidth}px`
      : iconOnly
        ? `${TAB_ICON_ONLY_WIDTH_PX}px`
        : density.condensed
          ? 'var(--tab-strip-active-width)'
          : null
  return {
    className: cn(
      fixedWidth !== null
        ? 'w-[var(--tab-slot-width)] flex-none'
        : sizing === 'terminal'
          ? TERMINAL_TAB_CONTAINER_WIDTH_CLASSES
          : CONTENT_TAB_CONTAINER_WIDTH_CLASSES,
      // Reserve a stable editing width without measuring or storing layout in React.
      'has-[[data-tab-rename-input]]:w-[300px] has-[[data-tab-rename-input]]:flex-none',
      docks && 'sticky inset-x-0 z-10'
    ),
    style:
      fixedWidth !== null ? ({ '--tab-slot-width': fixedWidth } as React.CSSProperties) : undefined,
    'data-tab-strip-slot': tabId,
    'data-active-tab-dock': docks ? '' : undefined,
    'data-tab-density': iconOnly ? 'icon' : undefined
  }
}
