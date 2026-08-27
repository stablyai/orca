import React from 'react'
import type { LucideIcon } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { StatusPillTone } from './workspace-cleanup-candidate-row-data'

export function WorkspaceCleanupMetadataChip({
  icon: Icon,
  label,
  value,
  tone = 'neutral'
}: {
  icon: LucideIcon
  label: string
  value?: string
  tone?: StatusPillTone
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-1.5 text-[11px] font-medium',
            'border-border bg-background text-muted-foreground',
            tone === 'ready' &&
              'border-[color:color-mix(in_srgb,var(--git-decoration-added)_45%,transparent)] bg-[color:color-mix(in_srgb,var(--git-decoration-added)_10%,transparent)] text-[var(--git-decoration-added)]',
            tone === 'review' && 'bg-muted text-foreground',
            tone === 'destructive' && 'border-destructive/30 text-destructive'
          )}
          aria-label={label}
        >
          <Icon className="size-3" aria-hidden="true" />
          {value ? <span>{value}</span> : null}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
