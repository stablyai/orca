import React from 'react'
import { GitFork } from 'lucide-react'
import type { GitHubRepositoryIdentity } from '../../../../shared/types'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * Small muted glyph marking a repo as a fork, with a "Fork of owner/repo"
 * tooltip. Renders nothing when the repo has no resolved upstream.
 */
export function RepoForkIndicator({
  upstream,
  className
}: {
  upstream: GitHubRepositoryIdentity | null | undefined
  className?: string
}): React.JSX.Element | null {
  if (!upstream) {
    return null
  }
  const label = `Fork of ${upstream.owner}/${upstream.repo}`
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn('inline-flex shrink-0 items-center text-muted-foreground', className)}
          aria-label={label}
        >
          <GitFork className="size-3" aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
