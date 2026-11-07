import React from 'react'
import { Link2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { MetadataActionIcon } from '../metadata/WorktreeCardMetadataControls'
import type { WorktreeCardController } from '../controller/use-worktree-card-controller'
import WorktreeCardAgents from '../activity/WorktreeCardAgents'
import { WorktreeCardHeader } from './worktree-card-header'
import { buildWorktreeCardPresentation } from './worktree-card-presentation'
import {
  renderWorktreeCardIndicators,
  WorktreeCardIdentityHover
} from '../details/worktree-card-details-items'

const withoutTitleTooltip = (title: React.ReactElement): React.ReactElement => title

export function CompactWorktreeCardContent({
  card
}: {
  card: WorktreeCardController
}): React.JSX.Element {
  const presentation = buildWorktreeCardPresentation(card)
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
          label={translate('workspace.links.addReference', 'Add reference')}
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
    >
      <div data-compact-workspace-header="true">
        <WorktreeCardHeader
          card={card}
          presentation={{
            ...presentation,
            hasHoverDetails: true,
            titleWrapper: withoutTitleTooltip,
            showTitleRowIndicators: indicators !== null,
            titleRowIndicators: indicators
          }}
          agentDisclosure={summary}
          branchLabel={branchLabel}
        />
      </div>
    </WorktreeCardIdentityHover>
  )

  return (
    <div className="min-w-0">
      {card.showInlineAgentList ? (
        <WorktreeCardAgents
          worktreeId={card.worktree.id}
          agents={
            card.agentActivityDisplayMode === 'compact' ? card.compactInlineAgentRows : undefined
          }
          renderHeader={renderHeader}
        />
      ) : (
        renderHeader(null)
      )}
    </div>
  )
}
