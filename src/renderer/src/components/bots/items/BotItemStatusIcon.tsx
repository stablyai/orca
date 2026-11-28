// An item's status glyph: Planned a dashed ring, In progress a spinner while a linked worker runs (a ring
// otherwise), Waiting a grey ring with its lower half filled, Needs you an orange dot (grey once
// stale), Done a check, Canceled a slashed circle.
import { CircleCheck, CircleSlash } from 'lucide-react'
import { AgentWorkingSpinner } from '@/components/agent/status/AgentWorkingSpinner'
import { cn } from '@/lib/class-names'
import type { BotItemStatus } from '../../../../../shared/bots/bot-items'

// Every glyph shares the spinner's 10 px box and 2 px stroke, so a group's rows read at one weight.
const BOX = 'size-2.5 shrink-0'
const RING = `${BOX} rounded-full border-2`
const LUCIDE = { size: 10, strokeWidth: 2, absoluteStrokeWidth: true } as const

export function BotItemStatusIcon({
  status,
  live = false,
  stale = false,
  className
}: {
  status: BotItemStatus
  live?: boolean
  stale?: boolean
  className?: string
}): React.JSX.Element {
  switch (status) {
    case 'needs_you':
      return (
        <span
          aria-hidden
          className={cn(
            BOX,
            'rounded-full',
            stale ? 'bg-muted-foreground/60' : 'bg-agent-question',
            className
          )}
        />
      )
    case 'working':
      return live ? (
        <AgentWorkingSpinner className={cn(BOX, className)} />
      ) : (
        <span aria-hidden className={cn(RING, 'border-agent-working', className)} />
      )
    case 'waiting':
      return (
        // Lucide's ring at the same 10 px and 2 px stroke as Done and Canceled.
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={4.8}
          className={cn(BOX, 'overflow-visible text-muted-foreground', className)}
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M4.4 12a7.6 7.6 0 0 0 15.2 0z" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'planned':
      return (
        <span
          aria-hidden
          className={cn(RING, 'border-dashed border-muted-foreground', className)}
        />
      )
    case 'done':
      return (
        <CircleCheck
          aria-hidden
          {...LUCIDE}
          className={cn(BOX, 'text-status-success', className)}
        />
      )
    case 'canceled':
      return (
        <CircleSlash
          aria-hidden
          {...LUCIDE}
          className={cn(BOX, 'text-muted-foreground', className)}
        />
      )
  }
}
