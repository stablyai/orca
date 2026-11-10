import React from 'react'

import { shouldBeginWorktreeRename } from '../controller/worktree-card-model'
import type { WorktreeCardPresentation } from './worktree-card-presentation'
import {
  WorktreeCardDeleteQuickAction,
  WorktreeCardPrimaryBadge,
  WorktreeCardPrimaryStar,
  WorktreeCardRenameErrorButton,
  WorktreeCardRepoChip,
  WorktreeCardRuntimeHostMark,
  WorktreeCardSparseBadge
} from '../identity/worktree-card-header-items'
import { WorktreeCardSshHostControl } from '../host/WorktreeCardSshHostControl'
import { WorktreeTitleInlineRename } from '../identity/WorktreeTitleInlineRename'
import type { WorktreeCardController } from '../controller/use-worktree-card-controller'

export function WorktreeCardHeader({
  card,
  presentation
}: {
  card: WorktreeCardController
  presentation: WorktreeCardPresentation
}): React.JSX.Element {
  const {
    worktree,
    repo,
    cardDetails,
    affiliateListMode,
    renameRowKey,
    compactCards,
    newCardStyle,
    parsedRepoHost,
    sshTargetLabel,
    sshStatus,
    sshTargetRemoved,
    sshOwnerEnvironmentId,
    stopQuickActionPointerPropagation,
    isRuntimeDisconnected,
    runtimeHostLabel,
    visibleCardTitle,
    isDeleting,
    showUnreadEmphasis,
    setTitleRenaming,
    handleRenameTitle,
    renamingWorktreeId,
    setRenamingWorktreeId,
    titleRenaming,
    handleOpenRenameErrorDialog,
    isFolder,
    handleWorkspaceQuickAction
  } = card
  const {
    showPinnedRepoIcon,
    showInlineRepoBadge,
    showHeaderActions,
    showTitleRowPrimary,
    showDeleteQuickAction,
    showTitleRowIndicators,
    titleRowIndicators,
    titleWrapper
  } = presentation
  const hasHoverDetails = presentation.hasHoverDetails && !titleRenaming

  return (
    <div className="flex min-w-0 items-center justify-between gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {showPinnedRepoIcon && (
          <WorktreeCardRepoChip repo={repo!} showName={cardDetails.projectName} />
        )}

        {repo?.connectionId && (
          <WorktreeCardSshHostControl
            targetId={repo.connectionId}
            targetLabel={sshTargetLabel || repo.displayName}
            status={sshStatus}
            targetRemoved={sshTargetRemoved}
            sshOwnerEnvironmentId={sshOwnerEnvironmentId}
            iconOnly={compactCards || newCardStyle}
            onPointerDown={stopQuickActionPointerPropagation}
          />
        )}

        {!repo?.connectionId && parsedRepoHost?.kind === 'runtime' && (
          <WorktreeCardRuntimeHostMark
            disconnected={isRuntimeDisconnected}
            hostLabel={runtimeHostLabel}
          />
        )}

        {showInlineRepoBadge && (
          <WorktreeCardRepoChip repo={repo!} showName={cardDetails.projectName} />
        )}

        <WorktreeTitleInlineRename
          displayName={visibleCardTitle}
          disabled={isDeleting || affiliateListMode}
          showUnreadEmphasis={showUnreadEmphasis}
          dimReadTitle={newCardStyle}
          className="text-[13px] leading-5"
          editingClassName="flex-1"
          titleWrapper={titleWrapper}
          onEditingChange={affiliateListMode ? undefined : setTitleRenaming}
          onRename={handleRenameTitle}
          beginEditing={
            !affiliateListMode &&
            shouldBeginWorktreeRename(renamingWorktreeId, worktree.id, renameRowKey)
          }
          onBeginEditingConsumed={affiliateListMode ? undefined : () => setRenamingWorktreeId(null)}
        />

        {typeof worktree.firstAgentMessageRenameError === 'string' &&
        worktree.firstAgentMessageRenameError.length > 0 &&
        !titleRenaming ? (
          <WorktreeCardRenameErrorButton
            onPointerDown={stopQuickActionPointerPropagation}
            onOpen={handleOpenRenameErrorDialog}
          />
        ) : null}
        {!compactCards && worktree.isMainWorktree && !isFolder && (
          <WorktreeCardPrimaryBadge card={card} hasHoverDetails={hasHoverDetails} />
        )}

        {worktree.isSparse && (
          <WorktreeCardSparseBadge
            card={card}
            hasHoverDetails={hasHoverDetails}
            directories={worktree.sparseDirectories}
          />
        )}

        {showTitleRowIndicators && titleRowIndicators}
      </div>

      {showHeaderActions && (
        <div className="ml-auto flex shrink-0 items-center justify-center gap-1 pr-1.5">
          {showTitleRowPrimary && <WorktreeCardPrimaryStar />}

          {showDeleteQuickAction && (
            <WorktreeCardDeleteQuickAction
              onPointerDown={stopQuickActionPointerPropagation}
              onClick={handleWorkspaceQuickAction}
            />
          )}
        </div>
      )}
    </div>
  )
}
