import React from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import type { RuntimeHostResourceNotice } from '../../host-connections/runtime-host-resources'
import {
  CPU_COLUMN_CLS,
  MEM_COLUMN_CLS,
  METRIC_COLUMNS_CLS,
  ROW_TRAILING_GUTTER_CLS
} from './resource-usage-metrics'

// Stripes read as "unknown"; an empty or zero cell would read as idle.
const UNKNOWN_MEMORY_STYLE: React.CSSProperties = {
  backgroundImage:
    'repeating-linear-gradient(135deg, color-mix(in srgb, var(--status-warning) 45%, transparent) 0 3px, transparent 3px 6px)'
}

/** A paired server whose resources are unknown, shaped like the project rows around it. */
export function HostNoticeRow({
  notice
}: {
  notice: RuntimeHostResourceNotice
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2" tabIndex={0}>
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{notice.hostLabel}</span>
          <div className={cn(METRIC_COLUMNS_CLS, 'text-xs text-muted-foreground/50')}>
            <span className={CPU_COLUMN_CLS}>—</span>
            <span className={cn(MEM_COLUMN_CLS, 'flex justify-end')}>
              <span
                className="block h-2.5 w-12 rounded-sm"
                style={UNKNOWN_MEMORY_STYLE}
                aria-hidden
              />
            </span>
          </div>
          <span className={ROW_TRAILING_GUTTER_CLS} aria-hidden />
          <span className="sr-only">{notice.reason}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4} className="z-[70]">
        {notice.reason}
      </TooltipContent>
    </Tooltip>
  )
}
