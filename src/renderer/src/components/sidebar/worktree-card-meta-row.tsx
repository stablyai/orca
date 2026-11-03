import React from 'react'

import { DetachedHeadBadge } from '@/components/DetachedHeadBadge'
import CacheTimer from './CacheTimer'
import { WorktreeHostContextBadge } from './WorktreeHostContextBadge'
import { useWslHostDistro, WslHostMark } from '@/components/wsl-host-mark/WslHostMark'
import { getWorktreeExecutionHostId } from '../../../../shared/execution-host'
import { TruncatedSidebarLabel } from './truncated-sidebar-label'
import {
  WorktreeCardConflictBadge,
  WorktreeCardFolderPath,
  WorktreeCardMetaRepoBadge
} from './worktree-card-meta-items'
import type { WorktreeCardPresentation } from './worktree-card-presentation'
import type { WorktreeCardController } from './use-worktree-card-controller'

export function WorktreeCardMetaRow({
  card,
  presentation
}: {
  card: WorktreeCardController
  presentation: WorktreeCardPresentation
}): React.JSX.Element {
  const {
    worktree,
    repo,
    identityDisplay,
    isFolder,
    newCardStyle,
    branch,
    detachedHeadDisplay,
    conflictOperation,
    cacheStartedAt,
    cacheTtlMs
  } = card
  const {
    showRepoBadgeInMetaRow,
    showHostContextBadge,
    contextLabel,
    showIdentityInNewCard,
    hasHoverDetails,
    showBranch,
    showDetachedHeadInMetaRow,
    showConflictOperationBadge,
    showMetaRowDetails,
    detailsAndPorts
  } = presentation
  const wslDistro = useWslHostDistro(
    showHostContextBadge ? getWorktreeExecutionHostId(worktree, repo) : null
  )

  return (
    <div className="flex items-center gap-1.5 min-w-0" data-worktree-card-meta-row="">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        {showRepoBadgeInMetaRow && repo && <WorktreeCardMetaRepoBadge repo={repo} />}

        {showHostContextBadge &&
          (wslDistro ? (
            <WslHostMark distro={wslDistro} />
          ) : (
            <WorktreeHostContextBadge label={contextLabel ?? ''} />
          ))}

        {showIdentityInNewCard ? (
          <TruncatedSidebarLabel
            text={identityDisplay!}
            className="text-[11px] text-muted-foreground leading-none"
            tooltipEnabled={!hasHoverDetails}
          />
        ) : isFolder && !newCardStyle ? (
          <WorktreeCardFolderPath path={worktree.path} />
        ) : showBranch ? (
          <TruncatedSidebarLabel
            text={branch}
            className="text-[11px] text-muted-foreground leading-none"
            // Why: whole-card details hover already shows full identity; a nested tooltip would compete for it.
            tooltipEnabled={!hasHoverDetails}
          />
        ) : showDetachedHeadInMetaRow && detachedHeadDisplay ? (
          <DetachedHeadBadge
            display={detachedHeadDisplay}
            label="sidebar"
            side="right"
            className="h-[16px]"
          />
        ) : null}

        {showConflictOperationBadge && conflictOperation && (
          <WorktreeCardConflictBadge operation={conflictOperation} />
        )}

        {cacheStartedAt != null && <CacheTimer startedAt={cacheStartedAt} ttlMs={cacheTtlMs} />}
      </div>

      {showMetaRowDetails && (
        <div className="ml-auto flex shrink-0 items-center gap-1 pr-1.5">{detailsAndPorts}</div>
      )}
    </div>
  )
}
