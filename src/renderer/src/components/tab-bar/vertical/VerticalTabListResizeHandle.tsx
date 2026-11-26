import type React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import {
  VERTICAL_TAB_LIST_MAX_WIDTH,
  VERTICAL_TAB_LIST_MIN_WIDTH
} from '../../../../../shared/workspace-layout/tab-strip-position'

const KEYBOARD_STEP_PX = 16

/** The list's right edge: drag to resize, arrow keys to step, double-click for the default width. */
export function VerticalTabListResizeHandle({
  width,
  isResizing,
  onResizeStart,
  onResetWidth,
  onStepWidth
}: {
  width: number
  isResizing: boolean
  onResizeStart: (event: React.MouseEvent) => void
  onResetWidth: () => void
  onStepWidth: (delta: number) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t(
        'auto.components.tab.bar.vertical.VerticalTabListResizeHandle.f16318a254',
        'Resize tab list'
      )}
      aria-valuenow={width}
      aria-valuemin={VERTICAL_TAB_LIST_MIN_WIDTH}
      aria-valuemax={VERTICAL_TAB_LIST_MAX_WIDTH}
      tabIndex={0}
      // Why 4px: matches the sidebars' resize targets; a 1px seam is too hard to acquire.
      className={cn(
        'absolute top-0 -right-0.5 z-10 h-full w-1 cursor-col-resize transition-colors hover:bg-ring/20 focus-visible:bg-ring/30 focus-visible:outline-none',
        isResizing && 'bg-ring/30'
      )}
      onMouseDown={onResizeStart}
      onDoubleClick={onResetWidth}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          onStepWidth(event.key === 'ArrowRight' ? KEYBOARD_STEP_PX : -KEYBOARD_STEP_PX)
        }
      }}
    />
  )
}
