import { getRootProjectHeaderKey } from '../drag/root-project-header-drop'
import React from 'react'
import { ChevronDown } from 'lucide-react'
import { ProjectHeaderHostLabel, ProjectHeaderHostTooltip } from './ProjectHeaderHostLabel'
import type { VirtualItem } from '@tanstack/react-virtual'
import { cn } from '@/lib/class-names'
import { RepoForkIndicator } from '@/components/repo/repo-fork-indicator'

import '@/store/project-groups/project-group-owner-routing'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import {
  getHeaderDragRepo,
  isSingleHostProjectHeader,
  type GroupHeaderRow
} from '../../../../../../shared/sidebar-list/row-types'
import { PINNED_GROUP_KEY } from '../../../../../../shared/sidebar-list/group-keys'
import { getWorkspaceStatusFromGroupKey } from '../../../../../../shared/workspace-statuses'
import { translateWorkspaceStatusHeaderLabel } from '../../workspace-board-status-label'
import { getVirtualRowTransform } from '../viewport/virtual-rows'
import { getSidebarHeaderVisual, renderSidebarHeaderGlyph } from './header-visuals'
import { resolveProjectGroupHeaderColor } from './project-header-color'
import { ProjectHeaderActions } from './ProjectHeaderActions'
import { getSectionHeaderDragState } from './section-header-drag-state'
import {
  getProjectGroupHeaderPaddingLeft,
  WORKTREE_SECTION_HEADER_PADDING_LEFT
} from './indentation'
import {
  FolderPathStatusIndicator,
  isFolderWorkspaceCreateDisabled
} from './FolderPathStatusIndicator'
import { RepoScanUnavailableIndicator } from './RepoScanUnavailableIndicator'
import {
  ProjectGroupCreateWorkspaceButton,
  ProjectGroupHeaderMenu
} from './project-group-header-actions'
import {
  RepoHeaderCreateWorkspaceButton,
  RepoHeaderProjectActionsMenu
} from './repo-header-project-actions'
import {
  handleRepoHeaderCollapseAffordancePointerDown,
  shouldIgnoreRepoHeaderToggle,
  toggleSectionHeaderCollapse
} from './header-event-guards'
import { getWorktreeOptionId } from './option-dom'
import type { SectionHeaderRowContext } from './section-header-row-context'
import type { Translate } from '@/i18n/use-translate'

export function renderWorktreeSectionHeaderRow(
  args: {
    ctx: SectionHeaderRowContext
    row: GroupHeaderRow
    vItem: VirtualItem
    isActiveStickyHeader: boolean
    hasStickyHost: boolean
    hasHeaderTopSpacing: boolean
    measureVirtualRowElement: (element: HTMLDivElement | null) => void
  },
  t?: Translate
): React.JSX.Element {
  const { ctx, row, vItem, isActiveStickyHeader } = args
  const { headerDrag } = ctx
  const displayRepo = row.displayRepo ?? row.repo
  const contextRepo = row.contextRepo ?? row.repo
  const isRepoHeader = ctx.groupBy === 'repo' && row.repo !== undefined
  const hasRepoChrome =
    ctx.groupBy === 'repo' && (displayRepo !== undefined || contextRepo !== undefined)
  const isProjectGroupHeader = ctx.groupBy === 'repo' && row.projectGroup !== undefined
  const usesRootProjectDrag = Boolean(
    headerDrag.rootProjectHeaderKeys && (row.projectGroupDepth ?? 0) === 0
  )
  const headerRepo = isRepoHeader
    ? usesRootProjectDrag
      ? (row.anchorRepo ?? row.repo)
      : getHeaderDragRepo(row)
    : undefined
  const projectIdForHeader = headerRepo?.id
  const projectGroupIdForHeader =
    isProjectGroupHeader && !row.repo && typeof row.projectGroup?.id === 'string'
      ? row.projectGroup.id
      : undefined
  const projectGroupDragIdForHeader =
    row.repeated && !usesRootProjectDrag ? undefined : projectGroupIdForHeader
  // Why: rename/delete must route to the host that owns this row, not to whichever host has focus.
  const projectGroupHostIdForHeader =
    row.projectGroup && 'createdFrom' in row.projectGroup
      ? getRepoExecutionHostId(row.projectGroup)
      : undefined
  const rootProjectHeaderKey = usesRootProjectDrag ? getRootProjectHeaderKey(row) : undefined
  const {
    repoHeaderIndex,
    repoHeaderBucketKey,
    projectGroupHeaderIndex,
    projectGroupHeaderBucketKey,
    rootProjectHeaderSectionEnd,
    isDraggableRepoHeader,
    isDraggableProjectGroupHeader,
    isDraggingThis,
    isDraggingThisProjectGroup
  } = getSectionHeaderDragState(headerDrag, {
    rootProjectHeaderKey,
    projectIdForHeader,
    projectGroupDragIdForHeader,
    hostId: row.hostId
  })
  const headerWorkspaceStatus =
    ctx.groupBy === 'workspace-status'
      ? getWorkspaceStatusFromGroupKey(row.key, ctx.workspaceStatuses, ctx.workspaceStatusById)
      : null
  const isPinnedHeader = row.key === PINNED_GROUP_KEY
  const headerVisual = getSidebarHeaderVisual(
    row.icon,
    ctx.workspaceStatuses,
    ctx.workspaceStatusById,
    t
  )
  const label = translateWorkspaceStatusHeaderLabel(
    headerWorkspaceStatus,
    row.label ?? headerVisual.label ?? ''
  )
  const hostContext =
    ctx.groupBy === 'repo' ? ctx.projectHeaderHostContexts?.get(row.key) : undefined
  const repoHeaderColor = resolveProjectGroupHeaderColor({
    groupBy: ctx.groupBy,
    headerKey: row.key,
    badgeColor: displayRepo?.badgeColor
  })
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
  const collapseKey = row.collapseKey ?? row.key
  const isHeaderCollapsed = ctx.collapsedGroups.has(collapseKey)
  const toggleHeader = (event: React.MouseEvent | React.KeyboardEvent): void =>
    toggleSectionHeaderCollapse(event, collapseKey, ctx)
  // Why: repo/project/status/pinned share compact section chrome; flat "All" stays a simple label.
  const showHeaderCollapseAffordance =
    row.count > 0 &&
    (hasRepoChrome || isProjectGroupHeader || headerWorkspaceStatus !== null || isPinnedHeader)
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
      <ProjectHeaderHostTooltip label={label} context={hostContext}>
        <div
          id={getWorktreeOptionId(row.key)}
          role="button"
          tabIndex={0}
          aria-label={hostContext ? `${label} — ${hostContext.label}` : undefined}
          aria-expanded={showHeaderCollapseAffordance ? !isHeaderCollapsed : undefined}
          data-project-grouping-key={row.key}
          data-root-project-header-key={rootProjectHeaderKey}
          data-root-project-header-host={rootProjectHeaderKey ? (row.hostId ?? '') : undefined}
          data-root-project-header-section-end={rootProjectHeaderSectionEnd}
          data-repo-header-id={projectIdForHeader}
          data-repo-header-index={repoHeaderIndex}
          data-repo-header-bucket={repoHeaderBucketKey}
          data-repo-header-section-end={
            projectIdForHeader
              ? headerDrag.repoHeaderSectionEndByRepoId.get(projectIdForHeader)
              : undefined
          }
          // Padding remains a drag handle; only the title shows grab so action buttons never inherit it.
          data-repo-header-drag-handle={isDraggableRepoHeader ? '' : undefined}
          data-project-group-header-id={projectGroupDragIdForHeader}
          data-project-group-header-index={projectGroupHeaderIndex}
          data-project-group-header-bucket={projectGroupHeaderBucketKey}
          data-project-group-header-section-end={
            projectGroupDragIdForHeader
              ? headerDrag.projectGroupHeaderSectionEndByGroupId.get(projectGroupDragIdForHeader)
              : undefined
          }
          data-project-group-header-drag-handle={isDraggableProjectGroupHeader ? '' : undefined}
          data-workspace-status-drop-target={headerWorkspaceStatus ? '' : undefined}
          data-workspace-status={headerWorkspaceStatus ?? undefined}
          data-workspace-pin-drop-target={isPinnedHeader ? '' : undefined}
          className={cn(
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
            hasRepoChrome && 'overflow-hidden'
          )}
          style={{
            // Why: non-project headers like "All" are flat-list labels; don't reserve project hierarchy indent.
            paddingLeft:
              hasRepoChrome || isProjectGroupHeader
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
            isDraggableRepoHeader && headerRepo
              ? (event) => headerDrag.repoDrag.onHandlePointerDown(event, headerRepo)
              : isDraggableProjectGroupHeader && projectGroupDragIdForHeader
                ? (event) =>
                    headerDrag.projectGroupDrag.onHandlePointerDown(
                      event,
                      projectGroupDragIdForHeader
                    )
                : undefined
          }
          onClick={(event) => {
            if (!shouldIgnoreRepoHeaderToggle(event)) {
              toggleHeader(event)
            }
          }}
          onKeyDown={(e) => {
            if (shouldIgnoreRepoHeaderToggle(e)) {
              return
            }
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              toggleHeader(e)
            }
          }}
        >
          {/* Stretch the title’s grab area to row height; action attributes exclude buttons while padding still arms drag. */}
          <div
            data-repo-header-drag-handle={isDraggableRepoHeader ? '' : undefined}
            data-project-group-header-drag-handle={isDraggableProjectGroupHeader ? '' : undefined}
            className={cn(
              'flex min-w-0 flex-1 items-center gap-1.5 self-stretch',
              hostContext && 'can-hover:pr-18',
              (isDraggableRepoHeader || isDraggableProjectGroupHeader) &&
                'cursor-grab active:cursor-grabbing'
            )}
          >
            <div
              className={cn(
                'flex size-4 shrink-0 items-center justify-center rounded-[4px]',
                repoHeaderColor ? 'text-muted-foreground' : headerVisual.tone
              )}
            >
              {renderSidebarHeaderGlyph(displayRepo, repoHeaderColor, headerVisual.icon)}
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <div className="min-w-0 truncate text-[13px] font-semibold leading-4">{label}</div>
                {hostContext ? <ProjectHeaderHostLabel context={hostContext} /> : null}
                <RepoForkIndicator upstream={displayRepo?.upstream} />
                <FolderPathStatusIndicator status={projectGroupPathStatus} />
                {displayRepo ? <RepoScanUnavailableIndicator repo={displayRepo} /> : null}
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
                  toggleHeader(event)
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
                label={label}
                projectGroup={folderBackedProjectGroup}
                onRefreshProjectGroup={ctx.onRefreshProjectGroup}
                onRename={ctx.onRenameProjectGroup}
                onDelete={ctx.onDeleteProjectGroup}
              />
            ) : null}

            {folderBackedProjectGroup ? (
              <ProjectGroupCreateWorkspaceButton
                projectGroup={folderBackedProjectGroup}
                label={label}
                pathStatus={projectGroupPathStatus}
                disabled={isFolderWorkspaceCreateDisabled(projectGroupPathStatus)}
                onCreate={ctx.onCreateFolderWorkspace}
              />
            ) : null}

            {contextRepo && ctx.groupBy === 'repo' ? (
              <RepoHeaderProjectActionsMenu
                repo={row.repo}
                contextRepo={contextRepo}
                projectScope={row.projectScope}
                hostId={row.hostId}
                label={label}
                projectGroups={ctx.projectGroups}
                actions={ctx.projectActions}
              />
            ) : null}

            {contextRepo && ctx.groupBy === 'repo' ? (
              <RepoHeaderCreateWorkspaceButton
                key={`${contextRepo.executionHostId ?? 'local'}:${contextRepo.connectionId ?? ''}`}
                repo={contextRepo}
                projectScope={row.projectScope}
                label={label}
                pinHost={isSingleHostProjectHeader(row)}
                onCreateForRepo={ctx.projectActions.onCreateForRepo}
              />
            ) : null}
          </ProjectHeaderActions>
        </div>
      </ProjectHeaderHostTooltip>
    </div>
  )
}
