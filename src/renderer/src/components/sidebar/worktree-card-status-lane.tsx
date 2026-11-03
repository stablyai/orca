import React from 'react'

import { cn } from '@/lib/utils'
import { useWslHostOffForRepo } from './use-wsl-host-off-review'
import { WorktreeCardStatusSlot } from './WorktreeCardStatusSlot'
import type { WorktreeCardController } from './use-worktree-card-controller'

/** The box the status lane sits in; previews draw the same box around their own glyph. */
export function WorktreeCardStatusLaneBox({
  newCardStyle,
  affiliateList,
  children
}: {
  newCardStyle: boolean
  affiliateList: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex shrink-0 justify-center',
        newCardStyle ? 'mr-1 w-5 items-center' : 'items-start pt-[2px]',
        affiliateList && 'px-1'
      )}
      data-worktree-card-status-slot=""
    >
      {children}
    </div>
  )
}

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
    <WorktreeCardStatusLaneBox
      newCardStyle={card.newCardStyle}
      affiliateList={card.affiliateListMode}
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
    </WorktreeCardStatusLaneBox>
  )
}
