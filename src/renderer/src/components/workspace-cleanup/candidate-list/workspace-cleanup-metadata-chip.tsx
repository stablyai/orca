import React from 'react'
import type { LucideIcon } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import type { StatusPillTone } from './workspace-cleanup-candidate-row-data'

export function WorkspaceCleanupMetadataChip({
  icon: Icon,
  label,
  value,
  tone = 'neutral',
  toneClassName,
  wrap = false
}: {
  icon: LucideIcon
  label: string
  value?: string
  tone?: StatusPillTone
  /** Overrides `tone` for chips whose color comes from a domain state (e.g. review state). */
  toneClassName?: string
  /** Wrap instead of overflowing, for labels whose meaning must stay readable in narrow rows. */
  wrap?: boolean
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'border text-[11px] font-medium',
            // Why one box when wrapping: a long label stays a single tag, its icon beside the first line,
            // and padding sits inside max-w-full so nothing reaches past the cell.
            wrap
              ? 'inline-flex w-fit max-w-full items-start gap-1 rounded-[10px] px-1.5 py-px leading-4'
              : 'inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5',
            'border-border bg-background text-muted-foreground',
            tone === 'ready' &&
              'border-[color:color-mix(in_srgb,var(--git-decoration-added)_45%,transparent)] bg-[color:color-mix(in_srgb,var(--git-decoration-added)_10%,transparent)] text-[var(--git-decoration-added)]',
            tone === 'review' &&
              'border-status-warning-border bg-status-warning-background text-status-warning-text',
            tone === 'destructive' && 'border-destructive/30 text-destructive',
            toneClassName
          )}
          aria-label={label}
        >
          <Icon className={cn('size-3', wrap && 'mt-0.5 shrink-0')} aria-hidden="true" />
          {value ? (
            <span className={wrap ? 'min-w-0 [overflow-wrap:anywhere]' : undefined}>{value}</span>
          ) : null}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

/** Borderless counterpart to the chip: neutral facts read as text so pills stay reserved for status. */
export function WorkspaceCleanupMetadataText({
  icon: Icon,
  label,
  value,
  wrap = false,
  className
}: {
  icon: LucideIcon
  label: string
  value?: string
  /** Wrap instead of truncating, for text whose meaning must stay readable in narrow rows. */
  wrap?: boolean
  className?: string
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'inline-flex shrink-0 gap-1 text-xs text-muted-foreground',
            wrap ? 'min-h-5 min-w-0 max-w-full items-start py-0.5' : 'h-5 items-center',
            className
          )}
          aria-label={label}
        >
          <Icon className={cn('size-3 shrink-0', wrap && 'mt-0.5')} aria-hidden="true" />
          {value ? (
            <span className={wrap ? 'min-w-0 [overflow-wrap:anywhere]' : 'truncate'}>{value}</span>
          ) : null}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
