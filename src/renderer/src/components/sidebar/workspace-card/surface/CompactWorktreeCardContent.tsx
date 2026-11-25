import React from 'react'
import { Link2 } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { MetadataActionIcon } from '../metadata/WorktreeCardMetadataControls'
import type { WorktreeCardController } from '../controller/use-worktree-card-controller'
import WorktreeCardAgents from '../activity/WorktreeCardAgents'
import { CARD_IDENTITY_PARTS } from '../template/card-identity-parts'
import {
  renderWorktreeCardIndicators,
  WorktreeCardIdentityHover
} from '../details/worktree-card-details-items'

export function CompactWorktreeCardContent({
  card
}: {
  card: WorktreeCardController
}): React.JSX.Element {
  const t = useTranslate()
  const identity = (name: keyof typeof CARD_IDENTITY_PARTS, props = {}): React.ReactNode =>
    CARD_IDENTITY_PARTS[name].render(props, [], card)
  const pinnedRepo = card.inPinnedSection && card.repo && !card.showProjectName
  const branchLabel =
    !card.isFolder && card.branch !== card.visibleCardTitle.trim() ? card.branch : undefined
  const hoverIdentity = card.isFolder
    ? card.worktree.path
    : (card.detachedHeadDisplay?.sidebarLabel ?? card.identityDisplay ?? card.branch)
  const indicators = (
    <>
      {renderWorktreeCardIndicators(card)}
      {!card.affiliateListMode && (
        <MetadataActionIcon
          label={t('workspace.links.addReference', 'Add reference')}
          onClick={card.handleManageLinks}
          onPointerDown={card.stopQuickActionPointerPropagation}
        >
          <Link2 className="size-3.5" />
        </MetadataActionIcon>
      )}
    </>
  )
  const renderHeader = (summary: React.ReactNode): React.ReactElement => (
    <WorktreeCardIdentityHover
      card={card}
      branchName={hoverIdentity}
      workspaceTitle={card.visibleCardTitle}
      closed={card.titleRenaming}
    >
      <div data-compact-workspace-header="true" className="flex min-w-0 items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {pinnedRepo ? identity('RepoChip') : null}
          {card.repo?.connectionId ? identity('SshControl', { iconOnly: true }) : null}
          {!card.repo?.connectionId && card.parsedRepoHost?.kind === 'runtime'
            ? identity('RuntimeHostMark')
            : null}
          {identity('Title', { tooltip: false })}
          {card.compactLine && card.lineNote && !card.titleRenaming ? (
            <span className="-ml-1 shrink-0 text-2xs whitespace-nowrap text-muted-foreground">
              · {card.lineNote}
            </span>
          ) : null}
          {card.worktree.firstAgentMessageRenameError && !card.titleRenaming
            ? identity('RenameError')
            : null}
          {!card.compactCards && card.worktree.isMainWorktree && !card.isFolder
            ? identity('PrimaryBadge', { hasHoverDetails: !card.titleRenaming })
            : null}
          {card.worktree.isSparse
            ? identity('SparseBadge', { hasHoverDetails: !card.titleRenaming })
            : null}
          {identity('NotificationsMuted')}
          {branchLabel && !card.titleRenaming ? (
            <span
              className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
              data-compact-workspace-branch="true"
            >
              {branchLabel}
            </span>
          ) : null}
          {summary}
          {indicators}
          {card.compactLine && card.repo && !card.isFolder ? (
            <span className="ml-auto flex shrink-0">{identity('RepoChip')}</span>
          ) : null}
        </div>
        {((card.compactCards && card.worktree.isMainWorktree && !card.isFolder) ||
          card.showDeleteQuickAction) && (
          <div className="ml-auto flex shrink-0 items-center gap-1 pr-1.5">
            {card.compactCards && card.worktree.isMainWorktree && !card.isFolder
              ? identity('PrimaryStar')
              : null}
            {card.showDeleteQuickAction ? identity('DeleteQuickAction') : null}
          </div>
        )}
      </div>
    </WorktreeCardIdentityHover>
  )

  return (
    <div className="min-w-0">
      {card.showInlineAgentList ? (
        <WorktreeCardAgents
          worktreeId={card.worktree.id}
          executionHostId={card.worktree.hostId}
          renderHeader={renderHeader}
        />
      ) : (
        renderHeader(null)
      )}
    </div>
  )
}
