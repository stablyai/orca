import React from 'react'
import { GitFork } from 'lucide-react'
import type { GitHubRepositoryIdentity } from '../../../../shared/github/pull-request-types'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { cn } from '@/lib/utils'

/** Show fork identity only after resolving an upstream, with its owner/repo tooltip. */
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
