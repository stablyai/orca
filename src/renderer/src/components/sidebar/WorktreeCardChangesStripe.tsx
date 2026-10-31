import React from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { useWorktreeChangeSummaryStore } from '@/store/worktree-change-summary'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'

function changeCountLabel(changeCount: number, capped: boolean): string {
  if (capped) {
    return translate(
      'auto.components.sidebar.WorktreeCardChangesStripe.changeCount_capped',
      '{{count}}+ uncommitted or untracked changes',
      { count: changeCount }
    )
  }
  return changeCount === 1
    ? translate(
        'auto.components.sidebar.WorktreeCardChangesStripe.changeCount_one',
        '1 uncommitted or untracked change',
        { count: changeCount }
      )
    : translate(
        'auto.components.sidebar.WorktreeCardChangesStripe.changeCount_other',
        '{{count}} uncommitted or untracked changes',
        { count: changeCount }
      )
}

/** Left-edge marker for a checkout with uncommitted changes; unknown status renders nothing. */
export function WorktreeCardChangesStripe({
  worktree
}: {
  worktree: Pick<Worktree, 'id' | 'hostId'>
}): React.JSX.Element | null {
  const enabled = useAppStore((s) => s.settings?.showWorktreeUncommittedChanges !== false)
  const summary = useWorktreeChangeSummaryStore((s) =>
    s.summaryByIdentity.get(getWorktreeHostIdentity(worktree))
  )
  if (!enabled || !summary || summary.changeCount === 0) {
    return null
  }
  const label = changeCountLabel(summary.changeCount, summary.capped)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Unset top keeps the flex static position, so the stripe follows the title row in every card layout. */}
        <span className="absolute left-px flex h-5 w-2" data-worktree-card-changes-stripe="">
          <span
            className="h-full w-0.5 rounded-full"
            style={{ backgroundColor: 'var(--git-decoration-modified)' }}
            aria-hidden="true"
          />
          <span className="sr-only">{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
