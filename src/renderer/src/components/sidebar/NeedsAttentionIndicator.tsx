import type { JSX } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

type NeedsAttentionIndicatorProps = {
  /** Opaque, caller-provided reason from `orca worktree set --needs-attention`.
   *  Shown verbatim in the tooltip — no truncation/parsing, same posture as `comment`. */
  reason: string
  className?: string
}

/** Provider-agnostic "needs attention" glyph for the sidebar. Deliberately its own
 *  lane: not the agent-status permission bell (StatusIndicator) and not the PR
 *  ReviewIcon — this hook has no opinion on agents or GitHub. */
export function NeedsAttentionIndicator({
  reason,
  className
}: NeedsAttentionIndicatorProps): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-worktree-needs-attention=""
          className={cn('inline-flex size-5 shrink-0 items-center justify-center', className)}
        >
          <AlertTriangle className="size-3 text-status-warning" aria-hidden="true" />
          <span className="sr-only">{reason}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        <span>{reason}</span>
      </TooltipContent>
    </Tooltip>
  )
}
