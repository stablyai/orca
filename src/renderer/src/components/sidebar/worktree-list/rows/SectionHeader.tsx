import React from 'react'
import { ChevronDown } from 'lucide-react'
import type { VirtualItem } from '@tanstack/react-virtual'
import { cn } from '@/lib/utils'
import type { AppState } from '@/store/types'
import { RepoIconGlyph } from '@/components/repo/repo-icon'
import { RepoForkIndicator } from '@/components/repo/repo-fork-indicator'
import type { FolderWorkspacePathStatus } from '../../../../../../shared/folder-workspace-path-status'
import { isConfirmedStaleFolderPathStatus } from '../../../../../../shared/folder-workspace-path-status'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { getProjectGroupHostId } from '@/store/slices/project-group-owner-routing'
import type {
  WorkspaceStatus,
  WorkspaceStatusDefinition
} from '../../../../../../shared/worktree/types'
import type { GroupHeaderRow, WorktreeGroupBy } from '../grouping/row-types'
import { PINNED_GROUP_KEY } from '../grouping/group-keys'
import { getWorkspaceStatusFromGroupKey } from '../../workspace-status'
import { getVirtualRowTransform } from '../viewport/virtual-rows'
import { resolveProjectGroupHeaderColor } from '../../project-header-color'
import { getRepoHeaderCreateState } from '../../repo-header-create-state'
import { ProjectHeaderActions } from '../../ProjectHeaderActions'
import {
  getProjectGroupHeaderPaddingLeft,
  WORKTREE_SECTION_HEADER_PADDING_LEFT
} from './indentation'
import { FolderPathStatusIndicator } from './FolderPathStatusIndicator'
import {
  ProjectGroupCreateWorkspaceButton,
  ProjectGroupHeaderMenu
} from './project-group-header-actions'
import {
  RepoHeaderCreateWorkspaceButton,
  RepoHeaderProjectActionsMenu,
  type RepoHeaderProjectActions
} from './repo-header-project-actions'
import {
  handleRepoHeaderCollapseAffordancePointerDown,
  shouldIgnoreRepoHeaderToggle
} from './header-event-guards'
import type { WorktreeSidebarHeaderDrag } from '../drag/use-header-drag'
import { getWorktreeOptionId } from './option-dom'

export type SectionHeaderRowContext = {
  groupBy: WorktreeGroupBy
  collapsedGroups: Set<string>
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  projectGroups: readonly ProjectGroup[]
  sshConnectionStates: AppState['sshConnectionStates']
  highlightedRevealRowKey: string | null
  dragOverStatus: WorkspaceStatus | null
  pinDragOver: boolean
  headerDrag: WorktreeSidebarHeaderDrag
  getCachedFolderWorkspacePathStatus: (request: {
    scope: 'project-group'
    projectGroupId: string
  }) => FolderWorkspacePathStatus | null
  toggleGroupWithScrollAnchor: (groupKey: string) => void
  projectActions: RepoHeaderProjectActions
  onRenameProjectGroup: (groupId: string, currentName: string, hostId?: ExecutionHostId) => void
  onDeleteProjectGroup: (groupId: string, groupName: string, hostId?: ExecutionHostId) => void
  onCreateFolderWorkspace: (projectGroup: ProjectGroup) => void
  onWorkspaceStatusDragOver: (event: React.DragEvent, status: WorkspaceStatus) => void
  onWorkspaceStatusDragLeave: (event: React.DragEvent) => void
  onWorkspacePinDragOver: (event: React.DragEvent) => void
  onWorkspacePinDragLeave: (event: React.DragEvent) => void
  onWorkspaceStatusDrop: (event: React.DragEvent, status: WorkspaceStatus) => void
}

// The folder-scan project group whose parent path is gone can't create new workspaces.
function isFolderWorkspaceCreateDisabled(status: FolderWorkspacePathStatus | null): boolean {
  return (
    status?.exists === false &&
    (isConfirmedStaleFolderPathStatus(status) || status.reason === 'ambiguous-connection')
  )
}

export function renderWorktreeSectionHeaderRow(args: {
  ctx: SectionHeaderRowContext
  row: GroupHeaderRow
  vItem: VirtualItem
  isActiveStickyHeader: boolean
  hasStickyHost: boolean
  hasHeaderTopSpacing: boolean
  measureVirtualRowElement: (element: HTMLDivElement | null) => void
}): React.JSX.Element {
  const { ctx, row, vItem, isActiveStickyHeader } = args
  const { headerDrag } = ctx
  const isRepoHeader = ctx.groupBy === 'repo' && row.repo !== undefined
  const isProjectGroupHeader = ctx.groupBy === 'repo' && row.projectGroup !== undefined
  const projectIdForHeader = isRepoHeader ? row.repo!.id : undefined
  const projectGroupIdForHeader =
    isProjectGroupHeader && !row.repo && typeof row.projectGroup?.id === 'string'
      ? row.projectGroup.id
      : undefined
  // Why: rename/delete must route to the host that owns this row, not to whichever host has focus.
  const projectGroupHostIdForHeader =
    row.projectGroup && 'createdFrom' in row.projectGroup
      ? getProjectGroupHostId(row.projectGroup)
      : undefined
  const repoHeaderIndex =
    projectIdForHeader !== undefined
      ? headerDrag.repoHeaderIndexByRepoId.get(projectIdForHeader)
      : undefined
  const repoHeaderBucketKey =
    projectIdForHeader !== undefined
      ? headerDrag.repoHeaderBucketByRepoId.get(projectIdForHeader)
      : undefined
  const projectGroupHeaderIndex =
    projectGroupIdForHeader !== undefined
      ? headerDrag.projectGroupHeaderIndexByGroupId.get(projectGroupIdForHeader)
      : undefined
  const projectGroupHeaderBucketKey =
    projectGroupIdForHeader !== undefined
      ? headerDrag.projectGroupHeaderBucketByGroupId.get(projectGroupIdForHeader)
      : undefined
  const isDraggableRepoHeader = Boolean(
    headerDrag.canReorderRepoHeaders &&
    isRepoHeader &&
    projectIdForHeader &&
    repoHeaderBucketKey &&
    (headerDrag.sidebarRepoHeaderIdsByBucket.get(repoHeaderBucketKey)?.length ?? 0) > 1
  )
  const isDraggableProjectGroupHeader = Boolean(
    headerDrag.canReorderProjectGroupHeaders &&
    projectGroupIdForHeader &&
    projectGroupHeaderBucketKey &&
    (headerDrag.sidebarProjectGroupHeaderIdsByBucket.get(projectGroupHeaderBucketKey)?.length ??
      0) > 1
  )
  const isDraggingThis =
    headerDrag.canReorderRepoHeaders &&
    headerDrag.repoDrag.state.draggingRepoId !== null &&
    headerDrag.repoDrag.state.draggingRepoId === projectIdForHeader
  const isDraggingThisProjectGroup =
    headerDrag.canReorderProjectGroupHeaders &&
    headerDrag.projectGroupDrag.state.draggingGroupId !== null &&
    headerDrag.projectGroupDrag.state.draggingGroupId === projectGroupIdForHeader
  const headerWorkspaceStatus =
    ctx.groupBy === 'workspace-status'
      ? getWorkspaceStatusFromGroupKey(row.key, ctx.workspaceStatuses)
      : null
  const isPinnedHeader = row.key === PINNED_GROUP_KEY
  const repoHeaderColor = resolveProjectGroupHeaderColor({
    groupBy: ctx.groupBy,
    headerKey: row.key,
    badgeColor: row.repo?.badgeColor
  })
  const createState = row.repo
    ? getRepoHeaderCreateState({
        repo: row.repo,
        label: row.label,
        sshStatus: row.repo.connectionId
          ? (ctx.sshConnectionStates.get(row.repo.connectionId)?.status ?? null)
          : null
      })
    : null
  const folderBackedProjectGroup =
    isProjectGroupHeader &&
    !row.repo &&
    row.projectGroup &&
    'parentPath' in row.projectGroup &&
    row.projectGroup.parentPath
      ? row.projectGroup
      : null
  const projectGroupPathStatus = folderBackedProjectGroup
    ? ctx.getCachedFolderWorkspacePathStatus({
        scope: 'project-group',
        projectGroupId: folderBackedProjectGroup.id
      })
    : null
  const isHeaderCollapsed = ctx.collapsedGroups.has(row.key)
  // Why: repo/project/status/pinned share compact section chrome; flat "All" stays a simple label.
  const showHeaderCollapseAffordance =
    row.count > 0 &&
    (isRepoHeader || isProjectGroupHeader || headerWorkspaceStatus !== null || isPinnedHeader)
  return (
    <div
      key={vItem.key}
      role="presentation"
      data-worktree-virtual-row
      data-worktree-virtual-row-key={String(vItem.key)}
      data-worktree-virtual-row-start={vItem.start}
      data-worktree-sticky-header=""
      data-worktree-sticky-header-active={isActiveStickyHeader ? '' : undefined}
      data-index={vItem.index}
      ref={args.measureVirtualRowElement}
      className={cn(
        'left-0 right-0',
        // Why: drop the inter-group spacer once the header pins so it sits flush at top (see getActiveStickyHeaderIndexForScroll).
        args.hasHeaderTopSpacing && !isActiveStickyHeader && 'pt-1',
        isActiveStickyHeader
          ? cn(
              'sticky z-20 bg-worktree-sidebar',
              // Why: when a host card is pinned, the group tier pins flush beneath it, not at the viewport top.
              args.hasStickyHost ? 'top-[35px]' : '-top-px'
            )
          : 'absolute top-0'
      )}
      style={isActiveStickyHeader ? undefined : { transform: getVirtualRowTransform(vItem.start) }}
    >
      <div
        id={getWorktreeOptionId(row.key)}
        role="button"
        tabIndex={0}
        aria-expanded={showHeaderCollapseAffordance ? !isHeaderCollapsed : undefined}
        data-repo-header-id={projectIdForHeader}
        data-repo-header-index={repoHeaderIndex}
        data-repo-header-bucket={repoHeaderBucketKey}
        data-repo-header-section-end={
          projectIdForHeader
            ? headerDrag.repoHeaderSectionEndByRepoId.get(projectIdForHeader)
            : undefined
        }
        // Why: row keeps handle attrs so indent/padding still arms drag; grab
        // cursor lives only on the title surface so … / + never inherit it.
        data-repo-header-drag-handle={isDraggableRepoHeader ? '' : undefined}
        data-project-group-header-id={projectGroupIdForHeader}
        data-project-group-header-index={projectGroupHeaderIndex}
        data-project-group-header-bucket={projectGroupHeaderBucketKey}
        data-project-group-header-section-end={
          projectGroupIdForHeader
            ? headerDrag.projectGroupHeaderSectionEndByGroupId.get(projectGroupIdForHeader)
            : undefined
        }
        data-project-group-header-drag-handle={isDraggableProjectGroupHeader ? '' : undefined}
        data-workspace-status-drop-target={headerWorkspaceStatus ? '' : undefined}
        data-workspace-status={headerWorkspaceStatus ?? undefined}
        data-workspace-pin-drop-target={isPinnedHeader ? '' : undefined}
        className={cn(
          // Why: no row-level grab — only the title surface below shows the hand;
          // actions use cursor-pointer so … / + never look reorderable.
          'group relative flex h-7 w-full items-center gap-1.5 pr-2 text-left transition-all',
          !(isDraggableRepoHeader || isDraggableProjectGroupHeader) && 'cursor-pointer',
          ctx.highlightedRevealRowKey === row.key &&
            'rounded-md bg-worktree-sidebar-accent ring-1 ring-worktree-sidebar-ring/50',
          (isDraggingThis || isDraggingThisProjectGroup) &&
            'bg-accent/80 ring-1 ring-ring/40 shadow-md rounded-md scale-[1.01]',
          headerWorkspaceStatus &&
            ctx.dragOverStatus === headerWorkspaceStatus &&
            'rounded-md bg-worktree-sidebar-accent ring-1 ring-worktree-sidebar-ring/40',
          isPinnedHeader &&
            ctx.pinDragOver &&
            'rounded-md bg-worktree-sidebar-accent ring-1 ring-worktree-sidebar-ring/40',
          row.repo && 'overflow-hidden'
        )}
        style={{
          // Why: non-project headers like "All" are flat-list labels; don't reserve project hierarchy indent.
          paddingLeft:
            isRepoHeader || isProjectGroupHeader
              ? getProjectGroupHeaderPaddingLeft(row.projectGroupDepth ?? 0)
              : WORKTREE_SECTION_HEADER_PADDING_LEFT
        }}
        onDragOver={
          isPinnedHeader
            ? ctx.onWorkspacePinDragOver
            : headerWorkspaceStatus
              ? (event) => ctx.onWorkspaceStatusDragOver(event, headerWorkspaceStatus)
              : undefined
        }
        onDragLeave={
          isPinnedHeader
            ? ctx.onWorkspacePinDragLeave
            : headerWorkspaceStatus
              ? ctx.onWorkspaceStatusDragLeave
              : undefined
        }
        onDrop={
          headerWorkspaceStatus
            ? (event) => ctx.onWorkspaceStatusDrop(event, headerWorkspaceStatus)
            : undefined
        }
        onPointerDown={
          isDraggableRepoHeader && projectIdForHeader
            ? (event) => headerDrag.repoDrag.onHandlePointerDown(event, projectIdForHeader)
            : isDraggableProjectGroupHeader && projectGroupIdForHeader
              ? (event) =>
                  headerDrag.projectGroupDrag.onHandlePointerDown(event, projectGroupIdForHeader)
              : undefined
        }
        onClick={(event) => {
          if (shouldIgnoreRepoHeaderToggle(event)) {
            return
          }
          ctx.toggleGroupWithScrollAnchor(row.key)
        }}
        onKeyDown={(e) => {
          if (shouldIgnoreRepoHeaderToggle(e)) {
            return
          }
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            ctx.toggleGroupWithScrollAnchor(row.key)
          }
        }}
      >
        {/* Why: grab cursor on icon+title only. Row still has handle attrs so
            indent/padding can arm drag; actions are excluded via data-repo-header-actions.
            self-stretch fills h-7 so grab matches the full title column height. */}
        <div
          data-repo-header-drag-handle={isDraggableRepoHeader ? '' : undefined}
          data-project-group-header-drag-handle={isDraggableProjectGroupHeader ? '' : undefined}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 self-stretch',
            (isDraggableRepoHeader || isDraggableProjectGroupHeader) &&
              'cursor-grab active:cursor-grabbing'
          )}
        >
          {row.icon ? (
            <div
              className={cn(
                'flex size-4 shrink-0 items-center justify-center rounded-[4px]',
                repoHeaderColor ? 'text-muted-foreground' : row.tone
              )}
            >
              {row.repo ? (
                <RepoIconGlyph
                  repoIcon={row.repo.repoIcon}
                  color={repoHeaderColor}
                  className="size-4"
                  iconClassName="size-3.5"
                />
              ) : (
                <row.icon className="size-3" />
              )}
            </div>
          ) : null}

          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <div className="min-w-0 truncate text-[13px] font-semibold leading-none">
                {row.label}
              </div>
              <RepoForkIndicator upstream={row.repo?.upstream} />
              <FolderPathStatusIndicator status={projectGroupPathStatus} />
            </div>
          </div>
        </div>

        <ProjectHeaderActions>
          {showHeaderCollapseAffordance ? (
            <div
              className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
              data-repo-header-collapse-affordance=""
              aria-hidden
              onPointerDown={handleRepoHeaderCollapseAffordancePointerDown}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                ctx.toggleGroupWithScrollAnchor(row.key)
              }}
            >
              <ChevronDown
                className={cn('size-3.5 transition-transform', isHeaderCollapsed && '-rotate-90')}
              />
            </div>
          ) : null}

          {isProjectGroupHeader && !row.repo && projectGroupIdForHeader ? (
            <ProjectGroupHeaderMenu
              groupId={projectGroupIdForHeader}
              hostId={projectGroupHostIdForHeader}
              label={row.label}
              onRename={ctx.onRenameProjectGroup}
              onDelete={ctx.onDeleteProjectGroup}
            />
          ) : null}

          {folderBackedProjectGroup ? (
            <ProjectGroupCreateWorkspaceButton
              projectGroup={folderBackedProjectGroup}
              label={row.label}
              pathStatus={projectGroupPathStatus}
              disabled={isFolderWorkspaceCreateDisabled(projectGroupPathStatus)}
              onCreate={ctx.onCreateFolderWorkspace}
            />
          ) : null}

          {row.repo && ctx.groupBy === 'repo' ? (
            <RepoHeaderProjectActionsMenu
              repo={row.repo}
              label={row.label}
              projectGroups={ctx.projectGroups}
              actions={ctx.projectActions}
            />
          ) : null}

          {row.repo && ctx.groupBy === 'repo' ? (
            <RepoHeaderCreateWorkspaceButton
              repo={row.repo}
              label={row.label}
              createState={createState}
              onCreateForRepo={ctx.projectActions.onCreateForRepo}
            />
          ) : null}
        </ProjectHeaderActions>
      </div>
    </div>
  )
}
