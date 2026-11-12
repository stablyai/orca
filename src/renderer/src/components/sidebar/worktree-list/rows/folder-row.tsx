import React from 'react'
import type { VirtualItem } from '@tanstack/react-virtual'
import { cn } from '@/lib/utils'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../../../../shared/repo-types'
import type {
  WorkspaceLineage,
  WorktreeLineage
} from '../../../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { isActiveSidebarWorkspace } from '../../../../../../shared/sidebar-list/active-workspace'

import {
  type FolderWorkspacePathStatus,
  isConfirmedStaleFolderPathStatus
} from '../../../../../../shared/folder-workspaces/folder-workspace-path-status'
import { folderWorkspaceToWorktree } from '../../../../../../shared/folder-workspaces/folder-workspace-worktree'
import WorktreeCard from '../../workspace-card/surface/WorktreeCard'
import type { WorktreeGroupBy } from '../../../../../../shared/sidebar-list/row-types'
import { getWorktreeVirtualRowTransform } from '../viewport/virtual-rows'
import {
  getFolderWorkspaceRowGeometry,
  getLineageChildrenInlineStyle,
  LINEAGE_CHILDREN_INLINE_OFFSET
} from './indentation'
import type { LineageToggleHandler } from '../../workspace-card/identity/worktree-lineage-toggle-handler-cache'
import { getFolderWorkspaceCardPrDisplay } from '../../workspace-card/review/folder-workspace-card-pr-display'
import { FolderPathStatusIndicator } from './FolderPathStatusIndicator'
import type { WorktreeItemRowContext } from './item-row'
import type { FolderWorkspaceItemRow } from '../listing/renderable-rows'
import { forwardOptionPressToCardSurface, getWorktreeOptionId } from './option-dom'

export type FolderWorkspaceRowContext = {
  groupBy: WorktreeGroupBy
  newCardStyle: boolean
  settings: AppState['settings']
  groupKeyByRowKey: ReadonlyMap<string, string>
  groupIndexByRowKey: ReadonlyMap<string, number>
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: AppState['activeWorkspaceExecutionHostId']
  currentWorktreeId: string | null
  selectedWorktreeIds: ReadonlySet<string>
  repoMap: Map<string, Repo>
  worktreeMap: Map<string, Worktree>
  worktreeLineageById: Record<string, WorktreeLineage>
  workspaceLineageByChildKey: Record<string, WorkspaceLineage>
  crossStoreChildrenByFolderId: ReadonlyMap<string, readonly Worktree[]>
  prCache: AppState['prCache'] | null
  hostedReviewCache: AppState['hostedReviewCache'] | null
  getCachedFolderWorkspacePathStatus: (request: {
    scope: 'folder-workspace'
    folderWorkspaceId: string
  }) => FolderWorkspacePathStatus | null
  onSelectionGesture: (event: React.MouseEvent<HTMLElement>, worktree: Worktree) => boolean
  onContextMenuSelect: (
    event: React.MouseEvent<HTMLElement>,
    worktree: Worktree
  ) => readonly Worktree[]
  onImmediateActivate: (worktreeId: string, rowKey: string | undefined) => void
  onRowClickCapture: (event: React.MouseEvent<HTMLDivElement>) => void
  onRowPointerDown: (
    event: React.PointerEvent<HTMLDivElement>,
    worktree: Worktree,
    rowKey: string
  ) => void
} & Pick<WorktreeItemRowContext, 'worktreeDragState' | 'nativeLineageDropTargetIdentity'>

/** The folder's own nested workspaces: its disclosure, and their cards when shown inline. */
export type FolderRowLineage = {
  onToggle: LineageToggleHandler | undefined
  children?: React.ReactNode
  childIsActive?: boolean
}

export function renderFolderWorkspaceVirtualRow(args: {
  ctx: FolderWorkspaceRowContext
  row: FolderWorkspaceItemRow
  vItem: VirtualItem
  measureVirtualRowElement: (element: HTMLDivElement | null) => void
  lineage?: FolderRowLineage
}): React.JSX.Element {
  return renderFolderWorkspaceOption(args)
}

/** Without `vItem`, the option sits inside a lineage group's frame instead of owning one. */
export function renderFolderWorkspaceOption(args: {
  ctx: FolderWorkspaceRowContext
  row: FolderWorkspaceItemRow
  vItem?: VirtualItem
  measureVirtualRowElement?: (element: HTMLDivElement | null) => void
  lineage?: FolderRowLineage
}): React.JSX.Element {
  const { ctx, row, vItem, lineage } = args
  const folderWorktree = folderWorkspaceToWorktree(row.folderWorkspace)
  const folderWorktreeIdentity = getWorktreeHostIdentity(folderWorktree)
  const isActiveWorktree = isActiveSidebarWorkspace(folderWorktree, {
    worktreeId: ctx.activeWorktreeId,
    hostId: ctx.activeWorkspaceExecutionHostId ?? null
  })
  const pathStatus = ctx.getCachedFolderWorkspacePathStatus({
    scope: 'folder-workspace',
    folderWorkspaceId: row.folderWorkspace.id
  })
  const activationDisabled =
    pathStatus?.exists === false &&
    (isConfirmedStaleFolderPathStatus(pathStatus) || pathStatus.reason === 'ambiguous-connection')
  const folderPrDisplay = getFolderWorkspaceCardPrDisplay({
    folderWorkspaceId: row.folderWorkspace.id,
    workspaceLineageByChildKey: ctx.workspaceLineageByChildKey,
    crossStoreChildren: ctx.crossStoreChildrenByFolderId.get(row.folderWorkspace.id) ?? [],
    worktreeLineageById: ctx.worktreeLineageById,
    worktreeMap: ctx.worktreeMap,
    repoMap: ctx.repoMap,
    hostedReviewCache: ctx.hostedReviewCache,
    prCache: ctx.prCache,
    settings: ctx.settings
  })
  const { surfaceInset, cardContentIndent } = getFolderWorkspaceRowGeometry({
    experimentalNewWorktreeCardStyle: ctx.newCardStyle,
    isFolderBackedWorkspaceChild:
      ctx.groupBy === 'repo' && row.projectGroup.createdFrom === 'folder-scan',
    isGrouped: ctx.groupBy !== 'none',
    groupDepth: row.groupDepth,
    lineageDepth: row.depth
  })
  const dragGroupKey = ctx.groupKeyByRowKey.get(folderWorktreeIdentity)
  const { draggingWorktreeId, previewOffsetsByWorktreeId } = ctx.worktreeDragState
  const isDragging = draggingWorktreeId === folderWorktreeIdentity
  const option = (
    <div
      key={row.key}
      id={getWorktreeOptionId(folderWorktreeIdentity)}
      role="option"
      aria-selected={ctx.selectedWorktreeIds.has(folderWorktreeIdentity)}
      aria-current={isActiveWorktree ? 'page' : undefined}
      data-worktree-id={folderWorktree.id}
      data-worktree-host-identity={folderWorktreeIdentity}
      data-worktree-row-key={folderWorktreeIdentity}
      data-worktree-lineage-drop-row=""
      data-worktree-drag-id={dragGroupKey ? folderWorktree.id : undefined}
      data-worktree-drag-group-key={dragGroupKey}
      data-worktree-drag-group-index={ctx.groupIndexByRowKey.get(folderWorktreeIdentity)}
      className={cn(
        'relative transition-[opacity,filter] duration-150 ease-out',
        isDragging && 'pointer-events-none opacity-0'
      )}
      style={surfaceInset > 0 ? { paddingLeft: surfaceInset } : undefined}
      onClick={forwardOptionPressToCardSurface}
      onClickCapture={ctx.onRowClickCapture}
      onPointerDown={(event) => ctx.onRowPointerDown(event, folderWorktree, folderWorktreeIdentity)}
    >
      <WorktreeCard
        worktree={folderWorktree}
        repo={undefined}
        isActive={isActiveWorktree}
        // A child-active folder looks active without the active card's side effects.
        isActiveSurface={lineage?.childIsActive === true || isActiveWorktree}
        isCurrentWorktree={ctx.currentWorktreeId === folderWorktree.id}
        contentIndent={cardContentIndent}
        flushSurface
        nativeDragEnabled={false}
        onImmediateActivate={activationDisabled ? undefined : ctx.onImmediateActivate}
        activationRowKey={folderWorktreeIdentity}
        onSelectionGesture={(event) => ctx.onSelectionGesture(event, folderWorktree)}
        onContextMenuSelect={ctx.onContextMenuSelect}
        statusPrDisplay={folderPrDisplay}
        hostContextLabel={row.hostContextLabel}
        lineageChildCount={row.lineageChildCount}
        lineageChildWorktreeIds={row.lineageChildWorktreeIds}
        lineageCollapsed={row.lineageCollapsed}
        lineageChildren={lineage?.children}
        lineageChildrenStyle={
          lineage?.children
            ? getLineageChildrenInlineStyle(LINEAGE_CHILDREN_INLINE_OFFSET)
            : undefined
        }
        onLineageToggle={lineage?.onToggle}
        isLineageDropTarget={Boolean(
          ctx.worktreeDragState.draggingWorktreeId &&
          (ctx.worktreeDragState.lineageDropTargetIdentity === folderWorktreeIdentity ||
            ctx.nativeLineageDropTargetIdentity === folderWorktreeIdentity)
        )}
      />
      <div className="pointer-events-auto absolute right-3 top-1.5">
        <FolderPathStatusIndicator status={pathStatus} />
      </div>
    </div>
  )
  if (!vItem) {
    return option
  }
  // Why: the option row is the drag source; cloning the outer frame would carry its virtual offset into the drag preview.
  return (
    <div
      key={vItem.key}
      role="presentation"
      data-worktree-virtual-row
      data-worktree-virtual-row-key={String(vItem.key)}
      data-worktree-virtual-row-start={vItem.start}
      data-index={vItem.index}
      ref={args.measureVirtualRowElement}
      className={cn(
        'absolute left-0 right-0 top-0',
        isDragging && 'pointer-events-none',
        draggingWorktreeId !== null &&
          'transition-transform duration-150 ease-out will-change-transform'
      )}
      style={{
        transform: getWorktreeVirtualRowTransform(
          vItem.start,
          previewOffsetsByWorktreeId.get(folderWorktreeIdentity) ?? 0
        )
      }}
    >
      {option}
    </div>
  )
}
