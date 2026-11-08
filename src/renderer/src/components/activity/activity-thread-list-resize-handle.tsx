import type React from 'react'
import { cn } from '@/lib/utils'
import { useTranslate } from '@/i18n/use-translate'

export function ActivityThreadListResizeHandle({
  isResizing,
  onResizeStart
}: {
  isResizing?: boolean
  onResizeStart?: React.MouseEventHandler<HTMLDivElement>
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      aria-label={t(
        'auto.components.activity.ActivityPrototypePage.443690186e',
        'Resize activity thread list'
      )}
      title={t('auto.components.activity.ActivityPrototypePage.866083500b', 'Drag to resize')}
      className={cn(
        'group absolute -right-1.5 top-0 z-20 flex h-full w-3 cursor-col-resize items-stretch justify-center',
        isResizing && 'bg-ring/10'
      )}
      onMouseDown={onResizeStart}
      role="separator"
    >
      <div
        className={cn(
          'h-full w-px bg-border transition-colors group-hover:bg-ring/50',
          isResizing && 'bg-ring'
        )}
      />
    </div>
  )
}
