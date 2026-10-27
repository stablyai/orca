import React from 'react'

import { cn } from '@/lib/utils'
import { getWorkspaceAttachments } from '../../../../../../shared/workspace-attachments/workspace-attachments'
import { WorktreeCardChangesStripe } from '../changes/WorktreeCardChangesStripe'
import { WorktreeCardHeader } from './worktree-card-header'
import { WorktreeCardMetaRow } from '../metadata/worktree-card-meta-row'
import { WorktreeCardIdentityHover } from '../details/worktree-card-details-items'
import type { WorktreeCardPresentation } from './worktree-card-presentation'
import { WorktreeCardSecondaryRows } from './worktree-card-secondary-rows'
import { WorktreeCardStatusLane } from './worktree-card-status-lane'
import type { WorktreeCardController } from '../controller/use-worktree-card-controller'

export function WorktreeCardParentContent({
  card,
  presentation
}: {
  card: WorktreeCardController
  presentation: WorktreeCardPresentation
}): React.JSX.Element {
  const { worktree, showInlineAgentList, titleRenaming } = card
  const {
    titleOnlyCard,
    parentContentMarginLeft,
    showCombinedStatusSlot,
    showUnreadQuickAction,
    hasHoverDetails,
    hoverBranchName,
    hoverWorkspaceTitle
  } = presentation

  const identityContent = (
    <div
      className="group/worktree-card flex w-full min-w-0 flex-col gap-1.5"
      data-worktree-card-hover-trigger=""
    >
      <WorktreeCardHeader card={card} presentation={presentation} />
      {presentation.hasMetaRow && <WorktreeCardMetaRow card={card} presentation={presentation} />}
    </div>
  )
  // Why: status glyphs and agent rows own their tooltips; only identity content should open the larger details card.
  const identityContentWithHover =
    hasHoverDetails && !titleRenaming ? (
      <WorktreeCardIdentityHover
        card={card}
        branchName={hoverBranchName}
        workspaceTitle={hoverWorkspaceTitle}
      >
        {identityContent}
      </WorktreeCardIdentityHover>
    ) : (
      identityContent
    )

  return (
    <div
      className={cn('flex w-full min-w-0 gap-0.5', titleOnlyCard ? 'items-center' : 'items-start')}
      style={
        parentContentMarginLeft < 0 ? { marginLeft: `${parentContentMarginLeft}px` } : undefined
      }
      data-worktree-card-parent-content=""
    >
      <WorktreeCardChangesStripe worktree={worktree} />
      {showCombinedStatusSlot ? (
        <WorktreeCardStatusLane card={card} showUnreadAction={showUnreadQuickAction} />
      ) : null}

      <div
        className={cn(
          'flex min-w-0 flex-1 flex-col gap-1.5',
          // Why: inline agent rows intentionally outdent into the card gutter; inner elements handle truncation.
          showInlineAgentList || getWorkspaceAttachments(worktree).length > 1
            ? 'overflow-visible'
            : 'overflow-hidden'
        )}
      >
        {identityContentWithHover}
        <WorktreeCardSecondaryRows card={card} presentation={presentation} />
      </div>
    </div>
  )
}
