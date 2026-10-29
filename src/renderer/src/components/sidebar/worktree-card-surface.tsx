import React from 'react'
import { LoaderCircle } from 'lucide-react'

import { cn } from '@/lib/utils'
import { AutoRenameFailedDialog } from './AutoRenameFailedDialog'
import WorktreeContextMenu from './WorktreeContextMenu'
import { useIsSleepingWorktree } from './use-worktree-sleep-state'
import { WorktreeCardParentContent } from './worktree-card-parent-content'
import { buildWorktreeCardPresentation } from './worktree-card-presentation'
import type { WorktreeCardController } from './use-worktree-card-controller'

export function WorktreeCardSurface({ card }: { card: WorktreeCardController }): React.JSX.Element {
  const presentation = buildWorktreeCardPresentation(card)
  const {
    worktree,
    selectedWorktrees,
    onAssignWorkspaceStatus,
    affiliateListMode,
    isActiveSurface,
    activeSurfaceVariant,
    isMultiSelected,
    revealHighlight,
    revealHighlightTone,
    flushSurface,
    isLineageDropTarget,
    nativeDragEnabled,
    lineageChildren,
    lineageChildrenStyle,
    newCardStyle,
    titleRenaming,
    isDeleting,
    isRuntimeDisconnected,
    isQueuedForDeletion,
    deleteLabel,
    handleClick,
    handlePointerDown,
    handlePointerEnter,
    handlePointerLeave,
    handleDoubleClick,
    handleDragStart,
    handleDragEnd,
    handleContextMenuSelect,
    showRenameErrorDialog,
    setShowRenameErrorDialog
  } = card
  const { titleOnlyCard, cardStyle } = presentation
  const isSleeping = useIsSleepingWorktree(worktree.id)

  const parentCardContent = <WorktreeCardParentContent card={card} presentation={presentation} />

  const cardBody = (
    <div
      className={cn(
        'relative flex cursor-pointer flex-col pr-1.5 transition-[background-color,border-color,opacity,box-shadow] duration-200 outline-none select-none',
        titleOnlyCard ? 'py-2' : 'pt-1.25 pb-1.5',
        flushSurface ? 'ml-1 w-[calc(100%-0.25rem)]' : 'ml-1',
        'overflow-hidden rounded-lg',
        // Navigation updates the live attribute before React; it must own the complete active style.
        isLineageDropTarget
          ? 'border border-worktree-sidebar-foreground/40 bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground ring-1 ring-inset ring-worktree-sidebar-ring/60'
          : isActiveSurface
            ? 'border border-transparent'
            : 'border border-transparent worktree-sidebar-card-hover',
        isActiveSurface && isMultiSelected && 'ring-1 ring-worktree-sidebar-ring/35',
        revealHighlight && [
          'scroll-to-current-workspace-reveal-highlight',
          revealHighlightTone === 'ai' && 'scroll-to-current-workspace-reveal-highlight--ai'
        ],
        titleRenaming && '!border-transparent !bg-transparent !shadow-none !ring-0',
        isDeleting && 'opacity-50 grayscale cursor-not-allowed',
        // Dim disconnected runtimes only; ancestor opacity would make the SSH control’s error tint/spinner illegible.
        isRuntimeDisconnected && !isDeleting && 'opacity-60'
      )}
      data-worktree-card-surface="true"
      data-worktree-card-active={
        isActiveSurface && !isLineageDropTarget ? activeSurfaceVariant : undefined
      }
      data-worktree-card-selected={
        (isMultiSelected && !isActiveSurface && !isLineageDropTarget) || undefined
      }
      data-worktree-lineage-drop-target={isLineageDropTarget || undefined}
      onClick={handleClick}
      onPointerDown={affiliateListMode ? undefined : handlePointerDown}
      onPointerEnter={affiliateListMode ? undefined : handlePointerEnter}
      onPointerLeave={affiliateListMode ? undefined : handlePointerLeave}
      onDoubleClick={affiliateListMode ? undefined : handleDoubleClick}
      draggable={!affiliateListMode && nativeDragEnabled && !isDeleting && !titleRenaming}
      onDragStart={!affiliateListMode && nativeDragEnabled ? handleDragStart : undefined}
      onDragEnd={!affiliateListMode && nativeDragEnabled ? handleDragEnd : undefined}
      aria-busy={isDeleting}
      style={cardStyle}
    >
      {isDeleting && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-background/50 backdrop-blur-[1px]">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-background px-3 py-1 text-[11px] font-medium text-foreground shadow-sm border border-border/50">
            {!isQueuedForDeletion ? (
              <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />
            ) : null}
            {deleteLabel}
          </div>
        </div>
      )}
      {isSleeping && newCardStyle && !isDeleting ? (
        // Mix tokens for background-independent sleep dimming; scope to the parent so awake children stay bright.
        <div data-worktree-sleeping-dim="">{parentCardContent}</div>
      ) : (
        parentCardContent
      )}

      {lineageChildren ? (
        <div
          className={cn('space-y-1', newCardStyle ? 'mt-1.5' : 'mt-3')}
          data-worktree-lineage-children=""
          style={lineageChildrenStyle}
        >
          {lineageChildren}
        </div>
      ) : null}
    </div>
  )

  return (
    <>
      {affiliateListMode ? (
        cardBody
      ) : (
        <WorktreeContextMenu
          worktree={worktree}
          selectedWorktrees={selectedWorktrees}
          onContextMenuSelect={handleContextMenuSelect}
          onAssignWorkspaceStatus={onAssignWorkspaceStatus}
        >
          {cardBody}
        </WorktreeContextMenu>
      )}

      {typeof worktree.firstAgentMessageRenameError === 'string' &&
        worktree.firstAgentMessageRenameError.length > 0 && (
          <AutoRenameFailedDialog
            open={showRenameErrorDialog}
            onOpenChange={setShowRenameErrorDialog}
            worktreeId={worktree.id}
            worktreeName={worktree.displayName}
            error={worktree.firstAgentMessageRenameError}
          />
        )}
    </>
  )
}
