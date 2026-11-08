import type React from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { useSidebarResize } from '@/hooks/useSidebarResize'
import {
  TAB_DEFAULT_WIDTH,
  TAB_MAX_WIDTH,
  TAB_MIN_WIDTH,
  TAB_RESIZE_KEYBOARD_STEP,
  clampTabWidth
} from '../../../../shared/tab-strip-width'

/** Right-edge grip that resizes its parent tab-strip slot; must be the slot's direct child. */
export function TabStripSlotResizeHandle({ tabId }: { tabId: string }): React.JSX.Element {
  const t = useTranslate()
  const storedWidth = useAppStore((s) => s.tabWidthsById[tabId])
  const setTabWidth = useAppStore((s) => s.setTabWidth)
  const setWidth = useCallback((width: number) => setTabWidth(tabId, width), [setTabWidth, tabId])
  const slotRef = useRef<HTMLElement | null>(null)
  const { setContainer, isResizing, onResizeStart } = useSidebarResize<HTMLElement>({
    isOpen: true,
    width: storedWidth ?? TAB_DEFAULT_WIDTH,
    minWidth: TAB_MIN_WIDTH,
    maxWidth: TAB_MAX_WIDTH,
    deltaSign: 1,
    setWidth,
    getStartWidth: () => slotRef.current?.getBoundingClientRect().width ?? TAB_DEFAULT_WIDTH
  })
  const attachToSlot = useCallback(
    (handle: HTMLDivElement | null) => {
      slotRef.current = handle?.parentElement ?? null
      setContainer(slotRef.current)
    },
    [setContainer]
  )

  useLayoutEffect(() => {
    // Unsized tabs keep their CSS width (content-fit or terminal); the hook pins a default width otherwise.
    const slot = slotRef.current
    if (slot && storedWidth === undefined && !isResizing) {
      slot.style.width = ''
    }
  }, [isResizing, storedWidth])

  useEffect(() => {
    // Release flex sizing and the width cap while dragging so the width shows live.
    const slot = slotRef.current
    if (!isResizing || !slot) {
      return
    }
    slot.dataset.tabResizing = ''
    return () => {
      delete slot.dataset.tabResizing
    }
  }, [isResizing])

  const handleMouseDown = (event: React.MouseEvent): void => {
    event.stopPropagation()
    if (event.button !== 0) {
      return
    }
    // The drag overlay swallows the second click, so a native dblclick never reaches this element.
    if (event.detail >= 2) {
      event.preventDefault()
      setTabWidth(tabId, null)
      return
    }
    onResizeStart(event)
  }

  // WAI-ARIA window splitter: arrows move the edge, Enter restores the default.
  const handleKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      setTabWidth(tabId, null)
      return
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    const current = slotRef.current?.getBoundingClientRect().width ?? TAB_DEFAULT_WIDTH
    const step = TAB_RESIZE_KEYBOARD_STEP * (event.shiftKey ? 4 : 1)
    setTabWidth(tabId, clampTabWidth(current + (event.key === 'ArrowLeft' ? -step : step)))
  }

  return (
    <div
      ref={attachToSlot}
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={storedWidth ?? TAB_DEFAULT_WIDTH}
      aria-valuemin={TAB_MIN_WIDTH}
      aria-valuemax={TAB_MAX_WIDTH}
      tabIndex={0}
      aria-label={t('tabResizeHandle.label', 'Resize tab')}
      title={t(
        'tabResizeHandle.hint',
        'Drag or use the arrow keys to resize. Double-click or press Enter to reset.'
      )}
      data-tab-resize-handle=""
      className="group/tab-resize absolute -right-1 top-0 z-20 flex h-full w-2 cursor-col-resize justify-center outline-none"
      onMouseDown={handleMouseDown}
      onKeyDown={handleKeyDown}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <div
        className={cn(
          'h-full w-px bg-transparent transition-colors group-hover/tab-resize:bg-ring/50 group-focus-visible/tab-resize:bg-ring',
          isResizing && 'bg-ring'
        )}
      />
    </div>
  )
}
