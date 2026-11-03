import React from 'react'
import { LoaderCircle } from 'lucide-react'

import { cn } from '@/lib/utils'
import { AutoRenameFailedDialog } from './AutoRenameFailedDialog'
import WorktreeContextMenu from './WorktreeContextMenu'
import { useIsSleepingWorktree } from './use-worktree-sleep-state'
import { getWorktreeCardFrameGeometry } from './worktree-card-frame-geometry'
import type { WorktreeCardController } from './use-worktree-card-controller'
import { RecoverableRenderErrorBoundary } from '@/components/error-boundaries/RecoverableRenderErrorBoundary'
import { useSelectedPluginCard, type SelectedPluginCard } from '@/store/plugin-sidebar-cards'
import { useWorktreeAgentRows } from './useWorktreeAgentRows'
import { useWorktreeActivityStatus } from './use-worktree-activity-status'
import { usePluginCardFields } from '@/store/plugin-card-fields'
import { buildWorkspaceCardActivityFacts } from './workspace-card/build-workspace-card-activity-facts'
import { WorktreeCardFrameNeedsInput } from './worktree-card-frame-needs-input'
import {
  compiledPluginCard,
  pluginCardRevisionKey,
  renderDefaultWorkspaceCard,
  renderPluginWorkspaceCard,
  type CardRootAttrs,
  type DrawnWorkspaceCard
} from './workspace-card/render-workspace-card-template'

type DrawCardContent = (rootAttrs: CardRootAttrs) => DrawnWorkspaceCard | null

export function WorktreeCardSurface({ card }: { card: WorktreeCardController }): React.JSX.Element {
  const isSleeping = useIsSleepingWorktree(card.worktree.id)
  const pluginCard = useSelectedPluginCard()
  const drawOrcaCard = (): React.JSX.Element =>
    renderWorktreeCardSurface(card, isSleeping, (rootAttrs) =>
      renderDefaultWorkspaceCard(card, rootAttrs)
    )
  if (!pluginCard) {
    return drawOrcaCard()
  }
  // Why a reset key: a fixed plugin file, or another workspace in this row, gets a fresh try.
  return (
    <RecoverableRenderErrorBoundary
      boundaryId="workspace-card-plugin"
      surface="sidebar"
      reportAsCrash={false}
      resetKey={`${pluginCardRevisionKey(pluginCard.entry)}:${card.worktree.id}`}
      fallback={drawOrcaCard}
    >
      <PluginCardSurface card={card} isSleeping={isSleeping} selected={pluginCard} />
    </RecoverableRenderErrorBoundary>
  )
}

/** A plugin card's surface, as a component so the boundary above catches what it throws. */
function PluginCardSurface({
  card,
  isSleeping,
  selected
}: {
  card: WorktreeCardController
  isSleeping: boolean
  selected: SelectedPluginCard
}): React.JSX.Element {
  const roots = compiledPluginCard(selected.entry)?.roots
  // Agent rows and fields are subscribed only by cards whose template reads them.
  const agentRows = useWorktreeAgentRows(card.worktree.id, roots?.has('activity') === true)
  const status = useWorktreeActivityStatus(card.worktree.id)
  const fields = usePluginCardFields(
    selected.entry.pluginKey,
    card.worktree.id,
    roots?.has('fields') === true
  )
  return renderWorktreeCardSurface(
    card,
    isSleeping,
    (rootAttrs) =>
      renderPluginWorkspaceCard(card, selected.entry, rootAttrs, {
        cardOptions: selected.options,
        activity: buildWorkspaceCardActivityFacts(agentRows, status),
        fields
      }),
    // Why the frame draws it: a plugin card must not be able to hide that an agent needs input.
    status === 'permission'
  )
}

/** Orca's card frame around drawn content; content that cannot draw falls back to Orca's card,
 *  so the frame always matches the content inside it. */
function renderWorktreeCardSurface(
  card: WorktreeCardController,
  isSleeping: boolean,
  drawContent: DrawCardContent,
  frameNeedsInput = false
): React.JSX.Element {
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
    setShowRenameErrorDialog,
    contentIndent
  } = card
  const geometryFor = (statusLane: boolean) =>
    getWorktreeCardFrameGeometry({ flushSurface, contentIndent, statusLane })
  const rootAttrs: CardRootAttrs = (templateFrame) => {
    const { parentContentMarginLeft } = geometryFor(templateFrame.statusLane)
    return parentContentMarginLeft < 0
      ? { style: { marginLeft: `${parentContentMarginLeft}px` } }
      : undefined
  }
  const { content: parentCardContent, frame } =
    drawContent(rootAttrs) ?? renderDefaultWorkspaceCard(card, rootAttrs)
  const { cardStyle } = geometryFor(frame.statusLane)
  const titleOnlyCard = frame.singleLine

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
      {frameNeedsInput ? <WorktreeCardFrameNeedsInput /> : null}
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
            executionHostId={worktree.hostId}
            worktreeName={worktree.displayName}
            error={worktree.firstAgentMessageRenameError}
          />
        )}
    </>
  )
}
