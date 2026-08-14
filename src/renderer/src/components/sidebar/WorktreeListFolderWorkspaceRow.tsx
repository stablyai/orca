import type React from 'react'
import type { AppState } from '@/store/types'
import type { Repo, Worktree, WorktreeLineage, WorkspaceLineage } from '../../../../shared/types'
import type { FolderWorkspacePathStatus } from '../../../../shared/folder-workspace-path-status'
import { isConfirmedStaleFolderPathStatus } from '../../../../shared/folder-workspace-path-status'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import WorktreeCard from './WorktreeCard'
import { FolderWorkspacePathStatusIndicator } from './FolderWorkspacePathStatusIndicator'
import { getWorktreeOptionId } from './worktree-list-dom-activation'
import { getFolderWorkspaceCardPrDisplay } from './folder-workspace-card-pr-display'
import { getFolderWorkspaceRowGeometry } from './worktree-list-indentation'
import { getVirtualRowTransform, type RenderRow } from './worktree-list-virtual-rows'
import type { WorktreeGroupBy } from './worktree-list-groups'

type CardProps = React.ComponentProps<typeof WorktreeCard>
type FolderWorkspaceRow = Extract<RenderRow, { type: 'folder-workspace' }>
type Props = {
  row: FolderWorkspaceRow
  virtualItem: { key: React.Key; index: number; start: number }
  measureVirtualRowElement: (element: HTMLDivElement | null) => void
  getCachedFolderWorkspacePathStatus: (args: {
    scope: 'folder-workspace'
    folderWorkspaceId: string
  }) => FolderWorkspacePathStatus | null | undefined
  workspaceLineageByChildKey: Record<string, WorkspaceLineage>
  worktreeLineageById: Record<string, WorktreeLineage>
  worktreeMap: Map<string, Worktree>
  repoMap: Map<string, Repo>
  hostedReviewCache: AppState['hostedReviewCache'] | null
  prCache: AppState['prCache'] | null
  settings: AppState['settings']
  groupBy: WorktreeGroupBy
  newCardStyle: boolean
  selectedWorktreeIds: ReadonlySet<string>
  activeWorktreeId: string | null
  currentWorktreeId: string | null
  handleWorktreeRowClickCapture: React.MouseEventHandler<HTMLDivElement>
  handleWorktreeRowPointerDown: (
    event: React.PointerEvent<HTMLDivElement>,
    worktreeId: string,
    rowKey: string
  ) => void
  handleImmediateWorktreeRowActivate: CardProps['onImmediateActivate']
  onSelectionGesture: CardProps['onSelectionGesture']
  onContextMenuSelect: CardProps['onContextMenuSelect']
}

export function WorktreeListFolderWorkspaceRow({
  row,
  virtualItem,
  measureVirtualRowElement,
  getCachedFolderWorkspacePathStatus,
  workspaceLineageByChildKey,
  worktreeLineageById,
  worktreeMap,
  repoMap,
  hostedReviewCache,
  prCache,
  settings,
  groupBy,
  newCardStyle,
  selectedWorktreeIds,
  activeWorktreeId,
  currentWorktreeId,
  handleWorktreeRowClickCapture,
  handleWorktreeRowPointerDown,
  handleImmediateWorktreeRowActivate,
  onSelectionGesture,
  onContextMenuSelect
}: Props): React.JSX.Element {
  const folderWorktree = folderWorkspaceToWorktree(row.folderWorkspace)
  const pathStatus = getCachedFolderWorkspacePathStatus({
    scope: 'folder-workspace',
    folderWorkspaceId: row.folderWorkspace.id
  })
  const activationDisabled =
    pathStatus?.exists === false &&
    (isConfirmedStaleFolderPathStatus(pathStatus) || pathStatus.reason === 'ambiguous-connection')
  const folderPrDisplay = getFolderWorkspaceCardPrDisplay({
    folderWorkspaceId: row.folderWorkspace.id,
    workspaceLineageByChildKey,
    worktreeLineageById,
    worktreeMap,
    repoMap,
    hostedReviewCache,
    prCache,
    settings
  })
  const { surfaceInset, cardContentIndent } = getFolderWorkspaceRowGeometry({
    experimentalNewWorktreeCardStyle: newCardStyle,
    isFolderBackedWorkspaceChild:
      groupBy === 'repo' && row.projectGroup.createdFrom === 'folder-scan',
    isGrouped: groupBy !== 'none',
    groupDepth: row.groupDepth,
    lineageDepth: row.depth
  })
  return (
    <div
      key={virtualItem.key}
      id={getWorktreeOptionId(folderWorktree.id)}
      role="option"
      aria-selected={selectedWorktreeIds.has(folderWorktree.id)}
      aria-current={activeWorktreeId === folderWorktree.id ? 'page' : undefined}
      data-worktree-id={folderWorktree.id}
      data-worktree-row-key={folderWorktree.id}
      data-worktree-virtual-row
      data-worktree-virtual-row-key={String(virtualItem.key)}
      data-worktree-virtual-row-start={virtualItem.start}
      data-index={virtualItem.index}
      ref={measureVirtualRowElement}
      className="absolute left-0 right-0 top-0"
      style={{ transform: getVirtualRowTransform(virtualItem.start) }}
      onClickCapture={handleWorktreeRowClickCapture}
      onPointerDown={(event) =>
        handleWorktreeRowPointerDown(event, folderWorktree.id, folderWorktree.id)
      }
    >
      <div
        className="relative"
        style={surfaceInset > 0 ? { paddingLeft: surfaceInset } : undefined}
      >
        <WorktreeCard
          worktree={folderWorktree}
          repo={undefined}
          isActive={activeWorktreeId === folderWorktree.id}
          isCurrentWorktree={currentWorktreeId === folderWorktree.id}
          contentIndent={cardContentIndent}
          flushSurface
          nativeDragEnabled={false}
          onImmediateActivate={activationDisabled ? undefined : handleImmediateWorktreeRowActivate}
          activationRowKey={folderWorktree.id}
          onSelectionGesture={onSelectionGesture}
          onContextMenuSelect={onContextMenuSelect}
          statusPrDisplay={folderPrDisplay}
        />
        <div className="pointer-events-auto absolute right-3 top-1.5">
          <FolderWorkspacePathStatusIndicator status={pathStatus} />
        </div>
      </div>
    </div>
  )
}
