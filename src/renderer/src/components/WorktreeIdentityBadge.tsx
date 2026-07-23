import React from 'react'
import { GitCommitHorizontal, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { WorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'

// Both non-branch identity states share one badge; they differ by label + icon only
// (same git-decoration color — the STYLEGUIDE reserves those tokens for git status).
type IdentityBadgeDisplay = Extract<WorktreeGitIdentityDisplay, { kind: 'detached' | 'rebasing' }>

type WorktreeIdentityBadgeProps = {
  display: IdentityBadgeDisplay
  label?: 'sidebar' | 'source-control'
  side?: React.ComponentProps<typeof TooltipContent>['side']
  className?: string
}

export function WorktreeIdentityBadge({
  display,
  label = 'source-control',
  side = 'right',
  className
}: WorktreeIdentityBadgeProps): React.JSX.Element {
  const visibleLabel = label === 'sidebar' ? display.sidebarLabel : display.sourceControlLabel
  const Icon = display.kind === 'rebasing' ? RefreshCw : GitCommitHorizontal

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className={cn(
            'h-[18px] shrink-0 gap-1 rounded px-1.5 text-[10px] font-medium leading-none',
            'border-[color:color-mix(in_srgb,var(--git-decoration-modified)_30%,transparent)] bg-[color:color-mix(in_srgb,var(--git-decoration-modified)_8%,transparent)] text-[color:var(--git-decoration-modified)]',
            className
          )}
        >
          <Icon className="size-2.5" />
          {visibleLabel}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side={side} sideOffset={8}>
        {display.tooltip}
      </TooltipContent>
    </Tooltip>
  )
}
