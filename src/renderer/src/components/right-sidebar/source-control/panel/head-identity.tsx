import React from 'react'
import { DetachedHeadBadge } from '@/components/DetachedHeadBadge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import type { WorktreeGitIdentityDisplay } from '../../../../../../shared/worktree/git-identity-display'

export function HeadIdentity({
  display
}: {
  display: WorktreeGitIdentityDisplay
}): React.JSX.Element {
  const t = useTranslate()
  if (display.kind === 'detached') {
    return (
      <DetachedHeadBadge
        display={display}
        side="bottom"
        // Why: tooltip carries the full detached explanation; keep it keyboard-reachable.
        tabIndex={0}
        className="min-w-0 max-w-full shrink"
      />
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
