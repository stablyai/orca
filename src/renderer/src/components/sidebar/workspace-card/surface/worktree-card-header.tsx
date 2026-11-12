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
import { WorktreeCardHostMark } from '../host/WorktreeCardHostMark'
import { CloudAgentHeldMark } from '@/components/orca-cloud/CloudAgentHeldMark'
import { useIsCloudHostRow } from '@/lib/orca-cloud/cloud-host-rows'
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
  // "primary" is a local checkout's role; on a cloud row it only means the default branch (design-squad).
  const cloudRow = useIsCloudHostRow(worktree)
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
        {showPinnedRepoIcon && <WorktreeCardRepoChip repo={repo!} />}

        <WorktreeCardHostMark
          worktreeId={worktree.id}
          onPointerDown={stopQuickActionPointerPropagation}
          sshControl={
            repo?.connectionId ? (
              <WorktreeCardSshHostControl
                targetId={repo.connectionId}
                targetLabel={sshTargetLabel || repo.displayName}
                status={sshStatus}
                targetRemoved={sshTargetRemoved}
                sshOwnerEnvironmentId={sshOwnerEnvironmentId}
                iconOnly
                onPointerDown={stopQuickActionPointerPropagation}
              />
            ) : undefined
          }
          runtimeMark={
            !repo?.connectionId && parsedRepoHost?.kind === 'runtime' ? (
              <WorktreeCardRuntimeHostMark
                disconnected={isRuntimeDisconnected}
                hostLabel={runtimeHostLabel}
              />
            ) : undefined
          }
        />

        {showInlineRepoBadge && <WorktreeCardRepoChip repo={repo!} />}

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

        {/* N-03: the agent waits on its pane's strip (Orca Cloud): this mark is the signal away. */}
        {!titleRenaming ? <CloudAgentHeldMark worktreeId={worktree.id} /> : null}

        {typeof worktree.firstAgentMessageRenameError === 'string' &&
        worktree.firstAgentMessageRenameError.length > 0 &&
        !titleRenaming ? (
          <WorktreeCardRenameErrorButton
            onPointerDown={stopQuickActionPointerPropagation}
            onOpen={handleOpenRenameErrorDialog}
          />
        ) : null}
        {!compactCards && worktree.isMainWorktree && !isFolder && !cloudRow && (
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
          {showTitleRowPrimary && !cloudRow && <WorktreeCardPrimaryStar />}

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
