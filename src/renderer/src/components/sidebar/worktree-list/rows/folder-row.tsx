import React from 'react'
import type { VirtualItem } from '@tanstack/react-virtual'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../../../../shared/repo-types'
import type {
  WorkspaceLineage,
  WorktreeLineage
} from '../../../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { FolderWorkspacePathStatus } from '../../../../../../shared/folder-workspace-path-status'
import { isConfirmedStaleFolderPathStatus } from '../../../../../../shared/folder-workspace-path-status'
import { folderWorkspaceToWorktree } from '../../../../../../shared/folder-workspace-worktree'
import WorktreeCard from '../../WorktreeCard'
import type { WorktreeGroupBy } from '../grouping/row-types'
import { getVirtualRowTransform } from '../viewport/virtual-rows'
import { getFolderWorkspaceRowGeometry } from './indentation'
import { getFolderWorkspaceCardPrDisplay } from '../../folder-workspace-card-pr-display'
import { FolderPathStatusIndicator } from './FolderPathStatusIndicator'
import type { FolderWorkspaceItemRow } from '../listing/renderable-rows'
import { getWorktreeOptionId } from './option-dom'

export type FolderWorkspaceRowContext = {
  groupBy: WorktreeGroupBy
  newCardStyle: boolean
  settings: AppState['settings']
  activeWorktreeId: string | null
  currentWorktreeId: string | null
  selectedWorktreeIds: ReadonlySet<string>
  repoMap: Map<string, Repo>
  worktreeMap: Map<string, Worktree>
  worktreeLineageById: Record<string, WorktreeLineage>
  workspaceLineageByChildKey: Record<string, WorkspaceLineage>
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
}

export function renderFolderWorkspaceVirtualRow(args: {
  ctx: FolderWorkspaceRowContext
  row: FolderWorkspaceItemRow
  vItem: VirtualItem
  measureVirtualRowElement: (element: HTMLDivElement | null) => void
}): React.JSX.Element {
  const { ctx, row, vItem } = args
  const folderWorktree = folderWorkspaceToWorktree(row.folderWorkspace)
  const folderWorktreeIdentity = getWorktreeHostIdentity(folderWorktree)
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
  return (
    <div
      key={vItem.key}
      id={getWorktreeOptionId(folderWorktree.id)}
      role="option"
      aria-selected={ctx.selectedWorktreeIds.has(folderWorktreeIdentity)}
      aria-current={ctx.activeWorktreeId === folderWorktree.id ? 'page' : undefined}
      data-worktree-id={folderWorktree.id}
      data-worktree-host-identity={folderWorktreeIdentity}
      data-worktree-row-key={folderWorktree.id}
      data-worktree-virtual-row
      data-worktree-virtual-row-key={String(vItem.key)}
      data-worktree-virtual-row-start={vItem.start}
      data-index={vItem.index}
      ref={args.measureVirtualRowElement}
      className="absolute left-0 right-0 top-0"
      style={{ transform: getVirtualRowTransform(vItem.start) }}
      onClickCapture={ctx.onRowClickCapture}
      onPointerDown={(event) => ctx.onRowPointerDown(event, folderWorktree, folderWorktree.id)}
    >
      <div
        className="relative"
        style={surfaceInset > 0 ? { paddingLeft: surfaceInset } : undefined}
      >
        <WorktreeCard
          worktree={folderWorktree}
          repo={undefined}
          isActive={ctx.activeWorktreeId === folderWorktree.id}
          isCurrentWorktree={ctx.currentWorktreeId === folderWorktree.id}
          contentIndent={cardContentIndent}
          flushSurface
          nativeDragEnabled={false}
          onImmediateActivate={activationDisabled ? undefined : ctx.onImmediateActivate}
          activationRowKey={folderWorktree.id}
          onSelectionGesture={(event) => ctx.onSelectionGesture(event, folderWorktree)}
          onContextMenuSelect={ctx.onContextMenuSelect}
          statusPrDisplay={folderPrDisplay}
        />
        <div className="pointer-events-auto absolute right-3 top-1.5">
          <FolderPathStatusIndicator status={pathStatus} />
        </div>
      </div>
    </div>
  )
}
