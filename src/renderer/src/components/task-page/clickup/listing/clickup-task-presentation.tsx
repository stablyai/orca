import React from 'react'
import { Flag } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type {
  ClickUpPriority,
  ClickUpStatusOption,
  ClickUpUser
} from '../../../../../../shared/clickup/clickup-types'
import { safeClickUpColor } from '../../../../../../shared/clickup/clickup-color'

export function ClickUpStatusPill({
  status,
  className
}: {
  status: ClickUpStatusOption
  className?: string
}): React.JSX.Element {
  const color = safeClickUpColor(status.color)
  return (
    <span
      className={cn(
        'inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-border/60 bg-muted/35 px-1.5 py-0.5 text-[11px] font-medium text-foreground',
        className
      )}
    >
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full bg-muted-foreground/60"
        style={color ? { backgroundColor: color } : undefined}
      />
      <span className="truncate">{status.name}</span>
    </span>
  )
}

export function ClickUpPriorityLabel({
  priority,
  className
}: {
  priority: ClickUpPriority | null
  className?: string
}): React.JSX.Element | null {
  if (!priority) {
    return null
  }
  const color = safeClickUpColor(priority.color)
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground',
        className
      )}
    >
      <Flag aria-hidden className="size-3" style={color ? { color, fill: color } : undefined} />
      <span className="capitalize">{priority.label}</span>
    </span>
  )
}

function userInitial(user: ClickUpUser): string {
  return (user.username || user.email).trim().charAt(0).toUpperCase()
}

export function ClickUpAssignees({
  assignees,
  max = 3
}: {
  assignees: readonly ClickUpUser[]
  max?: number
}): React.JSX.Element | null {
  const t = useTranslate()
  if (assignees.length === 0) {
    return null
  }
  const shown = assignees.slice(0, max)
  const hidden = assignees.length - shown.length
  return (
    <div
      className="flex shrink-0 items-center -space-x-1.5"
      aria-label={assignees.map((user) => user.username).join(', ')}
    >
      {shown.map((user) => (
        <Tooltip key={user.id}>
          <TooltipTrigger asChild>
            <span className="inline-flex size-5 items-center justify-center overflow-hidden rounded-full border border-background bg-muted text-[10px] font-medium text-muted-foreground">
              {user.avatarUrl ? (
                <img src={user.avatarUrl} alt="" className="size-full object-cover" />
              ) : (
                userInitial(user)
              )}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {user.username || t('taskProviders.clickup.unknownUser', 'Unknown')}
          </TooltipContent>
        </Tooltip>
      ))}
      {hidden > 0 ? (
        <span className="inline-flex h-5 items-center rounded-full border border-background bg-muted px-1.5 text-[10px] text-muted-foreground">
          +{hidden}
        </span>
      ) : null}
    </div>
  )
}
