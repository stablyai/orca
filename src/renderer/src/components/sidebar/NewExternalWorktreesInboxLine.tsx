import React from 'react'
import { ChevronRight, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

type NewExternalWorktreesInboxLineProps = {
  repoDisplayName: string
  inboxCount: number
  pending: boolean
  error: string | null
  onReview?: () => void
  onSuppress?: () => void
  className?: string
}

export default function NewExternalWorktreesInboxLine({
  repoDisplayName,
  inboxCount,
  pending,
  error,
  onReview,
  onSuppress,
  className
}: NewExternalWorktreesInboxLineProps): React.JSX.Element | null {
  const suppressLabel = translate(
    'auto.components.sidebar.NewExternalWorktreesInboxLine.c3e8a1f4b2',
    "Don't show again"
  )
  const suppressAriaLabel = translate(
    'auto.components.sidebar.NewExternalWorktreesInboxLine.9f2d4c8b17',
    'Hide external worktrees permanently for {{value0}}',
    { value0: repoDisplayName }
  )
  const isSingular = inboxCount === 1
  const countLabel = isSingular
    ? translate(
        'auto.components.sidebar.NewExternalWorktreesInboxLine.2a6f31d8c7',
        'hidden worktree'
      )
    : translate(
        'auto.components.sidebar.NewExternalWorktreesInboxLine.5b90e4a2f6',
        'hidden worktrees'
      )
  const reviewAriaLabel = isSingular
    ? translate(
        'auto.components.sidebar.NewExternalWorktreesInboxLine.7f18c5b0d3',
        'Review {{value0}} hidden worktree in {{value1}}',
        { value0: inboxCount, value1: repoDisplayName }
      )
    : translate(
        'auto.components.sidebar.NewExternalWorktreesInboxLine.4e2b7a9c05',
        'Review {{value0}} hidden worktrees in {{value1}}',
        { value0: inboxCount, value1: repoDisplayName }
      )

  if (inboxCount === 0) {
    return null
  }

  return (
    <section
      aria-busy={pending}
      className={cn('mx-1 my-0.5 ml-3 text-worktree-sidebar-foreground', className)}
    >
      <div className="group relative">
        <button
          type="button"
          disabled={pending || !onReview}
          aria-label={reviewAriaLabel}
          onClick={onReview}
          className={cn(
            'flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md border border-worktree-sidebar-border px-2 py-1.5',
            'text-[11px] leading-none text-muted-foreground transition-colors',
            'hover:bg-worktree-sidebar-accent hover:text-worktree-sidebar-accent-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-worktree-sidebar-ring',
            'disabled:pointer-events-none disabled:opacity-60'
          )}
        >
          <span className="inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full border border-border px-1.5 text-[10px] font-medium leading-none tabular-nums">
            {inboxCount}
          </span>
          <span className="min-w-0 flex-1 truncate text-left">{countLabel}</span>
          <ChevronRight
            aria-hidden="true"
            className={cn(
              'size-3 shrink-0',
              // Why: the suppress control takes over this slot on hover.
              onSuppress &&
                'can-hover:group-hover:opacity-0 can-hover:group-focus-within:opacity-0 [@media(hover:none)]:opacity-0'
            )}
          />
        </button>
        {onSuppress ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={pending}
                aria-label={suppressAriaLabel}
                onClick={onSuppress}
                className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground hover:bg-worktree-sidebar-accent hover:text-worktree-sidebar-accent-foreground can-hover:pointer-events-none can-hover:opacity-0 can-hover:group-hover:pointer-events-auto can-hover:group-hover:opacity-100 can-hover:group-focus-within:pointer-events-auto can-hover:group-focus-within:opacity-100"
              >
                <X className="size-3" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {suppressLabel}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>

      {error ? (
        <p className="px-1.5 pb-1 pt-0.5 text-[11px] leading-4 text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  )
}
