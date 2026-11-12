import React from 'react'
import { GitFork } from 'lucide-react'
import type { GitHubRepositoryIdentity } from '../../../../shared/github/pull-request-types'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'

/** Show fork identity only after resolving an upstream, with its owner/repo tooltip. */
export function RepoForkIndicator({
  upstream,
  className
}: {
  upstream: GitHubRepositoryIdentity | null | undefined
  className?: string
}): React.JSX.Element | null {
  const t = useTranslate()
  if (!upstream) {
    return null
  }
  const label = t('auto.components.repo.forkIndicator.forkOf', 'Fork of {{repo}}', {
    repo: `${upstream.owner}/${upstream.repo}`
  })
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
