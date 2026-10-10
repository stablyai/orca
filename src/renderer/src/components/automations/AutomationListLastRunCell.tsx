import React from 'react'
import { cn } from '@/lib/utils'
import {
  formatAutomationLastRunCell,
  type AutomationLastRunSnapshot
} from './automation-list-last-run'

export function AutomationListLastRunCell({
  snapshot,
  now
}: {
  snapshot: AutomationLastRunSnapshot
  now: number
}): React.JSX.Element {
  const cell = formatAutomationLastRunCell(snapshot, now)
  const failed = cell.tone === 'failed'
  return (
    <span
      className={cn(
        'inline-flex min-w-0 items-center gap-1.5 truncate',
        failed ? 'text-destructive' : 'text-muted-foreground'
      )}
      title={cell.title}
    >
      {cell.tone !== 'never' ? (
        <span
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            failed ? 'bg-destructive' : 'bg-muted-foreground/70'
          )}
          aria-hidden="true"
        />
      ) : null}
      <span className="truncate">{cell.text}</span>
    </span>
  )
}
