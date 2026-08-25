import React from 'react'
import { translate } from '@/i18n/i18n'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DetachedHeadBadge } from '@/components/DetachedHeadBadge'
import type { WorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'

export function resolveHeadFlowLabel(
  display: WorktreeGitIdentityDisplay | null | undefined
): string | null {
  if (display?.kind === 'branch') {
    return display.branchName
  }
  if (display?.kind === 'detached') {
    return display.sourceControlLabel
  }
  return null
}

export function HeadIdentity({
  display,
  headSlot
}: {
  display: WorktreeGitIdentityDisplay
  headSlot?: React.ReactNode
}): React.JSX.Element {
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

  // Why: the switcher owns its own trigger label and popover; only fall back to
  // the static span when no switcher is available (folder workspace, no worktree).
  if (headSlot) {
    return <>{headSlot}</>
  }

  const branchAriaLabel = translate(
    'auto.components.right.sidebar.SourceControl.a4e93c21d7',
    'Current branch: {{value0}}',
    { value0: display.branchName }
  )

  // Why: focusable + tooltip so truncated long branch names stay discoverable.
  // Native title omitted — Radix Tooltip already surfaces the full name on hover.
  // `block` is load-bearing: `truncate` clips nothing on an inline box, so an
  // inline span here let long names run under the line-total chip.
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
