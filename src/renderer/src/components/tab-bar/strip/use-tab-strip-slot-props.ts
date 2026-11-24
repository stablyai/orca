import { useContext } from 'react'
import { cn } from '@/lib/class-names'
import { useAppStore } from '@/store/index'
import {
  normalizeTabMaxWidth,
  normalizeTabWidthMode,
  TAB_MAX_WIDTH_DEFAULT_PX
} from '../../../../../shared/workspace-layout/tab-groups/tab-width-settings'
import { useTabDragActive } from '../../tab-group/drag/tab-drag-context'
import {
  TERMINAL_TAB_CONTAINER_WIDTH_CLASSES,
  CONTENT_TAB_CONTAINER_WIDTH_CLASSES,
  FIT_TAB_CONTAINER_WIDTH_CLASSES
} from './tab-width-rules'
import { TabStripDensityContext } from './tab-strip-density-context'
import { TAB_ICON_ONLY_WIDTH_PX } from './tab-strip-width-budget'

type TabStripSlotStyle = React.CSSProperties & {
  '--tab-slot-width'?: string
  '--tab-max-width'?: string
}

type TabStripSlotProps = {
  className: string
  style: TabStripSlotStyle | undefined
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
  const tabWidthMode = useAppStore((s) => normalizeTabWidthMode(s.settings?.tabWidthMode))
  const tabMaxWidth = useAppStore((s) => normalizeTabMaxWidth(s.settings?.tabMaxWidth))
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
  const customMaxWidth = tabMaxWidth !== TAB_MAX_WIDTH_DEFAULT_PX ? `${tabMaxWidth}px` : undefined
  const style: TabStripSlotStyle | undefined =
    fixedWidth !== null || customMaxWidth !== undefined
      ? {
          ...(fixedWidth !== null ? { '--tab-slot-width': fixedWidth } : {}),
          ...(customMaxWidth !== undefined ? { '--tab-max-width': customMaxWidth } : {})
        }
      : undefined
  return {
    className: cn(
      fixedWidth !== null
        ? 'w-[var(--tab-slot-width)] max-w-[var(--tab-max-width,300px)] flex-none'
        : tabWidthMode === 'fit'
          ? FIT_TAB_CONTAINER_WIDTH_CLASSES
          : sizing === 'terminal'
            ? TERMINAL_TAB_CONTAINER_WIDTH_CLASSES
            : CONTENT_TAB_CONTAINER_WIDTH_CLASSES,
      // Reserve a stable editing width without measuring or storing layout in React.
      'has-[[data-tab-rename-input]]:w-[var(--tab-max-width,300px)] has-[[data-tab-rename-input]]:flex-none',
      docks && 'sticky inset-x-0 z-10'
    ),
    style,
    'data-tab-strip-slot': tabId,
    'data-active-tab-dock': docks ? '' : undefined,
    'data-tab-density': iconOnly ? 'icon' : undefined
  }
}
