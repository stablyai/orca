import React from 'react'
import { GitCommitHorizontal } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import type { WorktreeGitIdentityDisplay } from '../../../../../../shared/worktree/row-display/git-identity-display'

export function HeadIdentity({
  display
}: {
  display: WorktreeGitIdentityDisplay
}): React.JSX.Element {
  const t = useTranslate()
  if (display.kind === 'detached') {
    // Today's look without the badge box, so its icon sits on the header's 12px column like the
    // rows below instead of 7px in (border + padding).
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="flex min-w-0 max-w-full items-center gap-1 rounded-sm text-3xs leading-none font-medium text-[color:var(--git-decoration-modified)] outline-none focus-visible:ring-1 focus-visible:ring-ring"
            // Why: the tooltip carries the full detached explanation; keep it keyboard-reachable.
            tabIndex={0}
            data-testid="source-control-head-identity"
          >
            <GitCommitHorizontal className="size-2.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate" aria-hidden="true">
              {display.sourceControlLabel}
            </span>
            <span className="sr-only">{display.tooltip}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6} className="max-w-72">
          {display.tooltip}
        </TooltipContent>
      </Tooltip>
    )
  }

  const branchAriaLabel = t(
    'auto.components.right.sidebar.SourceControl.a4e93c21d7',
    'Current branch: {{value0}}',
    { value0: display.branchName }
  )

  // Keep full refs keyboard-discoverable; block layout lets truncate clip long names before they overlap totals.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="block min-w-0 max-w-full truncate rounded-sm font-mono text-[10.5px] font-medium text-foreground/90 outline-none focus-visible:ring-1 focus-visible:ring-ring"
          tabIndex={0}
          aria-label={branchAriaLabel}
          data-testid="source-control-head-identity"
        >
          {display.branchName}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6} className="max-w-72 break-all font-mono">
        {display.branchName}
      </TooltipContent>
    </Tooltip>
  )
}
