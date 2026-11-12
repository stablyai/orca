import React from 'react'

import { cn } from '@/lib/class-names'
import { useWslHostOffForRepo } from '../../use-wsl-host-off-review'
import { WorktreeCardStatusSlot } from './WorktreeCardStatusSlot'
import type { WorktreeCardController } from '../controller/use-worktree-card-controller'

/** The card's leading status lane: activity, review and the unread toggle or dot. */
export function WorktreeCardStatusLane({
  card,
  showUnreadAction
}: {
  card: WorktreeCardController
  showUnreadAction: boolean
}): React.JSX.Element {
  const reviewStale = useWslHostOffForRepo(card.repo)
  return (
    <div
      className={cn(
        'flex shrink-0 justify-center',
        card.newCardStyle ? 'mr-1 w-5 items-center' : 'items-start pt-[2px]',
        card.affiliateListMode && 'px-1'
      )}
      data-worktree-card-status-slot=""
    >
      <WorktreeCardStatusSlot
        worktreeId={card.worktree.id}
        showStatus={card.showStatus}
        showUnreadAction={showUnreadAction}
        isUnread={card.worktree.isUnread}
        unreadTooltip={card.unreadTooltip}
        onPointerDown={card.stopQuickActionPointerPropagation}
        onToggleUnread={card.handleToggleUnreadQuick}
        prDisplay={card.statusLaneReview}
        reviewChecks={card.reviewChecks.total > 0 ? card.reviewChecks : undefined}
        newCardStyle={card.newCardStyle}
        hasBranchIdentity={Boolean(card.branchIdentityDisplay)}
        reviewStale={reviewStale}
      />
    </div>
  )
}
