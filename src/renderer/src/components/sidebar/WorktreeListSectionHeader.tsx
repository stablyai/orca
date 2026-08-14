import type React from 'react'
import type { VirtualItem } from '@tanstack/react-virtual'
import { ChevronDown } from 'lucide-react'
import type { ProjectGroup, Repo, WorkspaceStatus } from '../../../../shared/types'
import { cn } from '@/lib/utils'
import { RepoIconGlyph } from '@/components/repo/repo-icon'
import { RepoForkIndicator } from '@/components/repo/repo-fork-indicator'
import { ProjectHeaderActions } from './ProjectHeaderActions'
import { FolderWorkspacePathStatusIndicator } from './FolderWorkspacePathStatusIndicator'
import type { GroupHeaderRow } from './worktree-list-groups'
import { getVirtualRowTransform } from './worktree-list-virtual-rows'
import { getWorktreeOptionId } from './worktree-list-dom-activation'
import type { WorktreeListSectionHeaderModel } from './worktree-list-section-header-model'
import {
  handleRepoHeaderCollapseAffordancePointerDown,
  shouldIgnoreRepoHeaderToggle
} from './worktree-list-project-header-events'
import { WorktreeListProjectGroupHeaderActions } from './WorktreeListProjectGroupHeaderActions'
import { WorktreeListRepoHeaderActions } from './WorktreeListRepoHeaderActions'

type WorktreeListSectionHeaderProps = {
  row: GroupHeaderRow
  virtualItem: VirtualItem
  model: WorktreeListSectionHeaderModel
  measureVirtualRowElement: (element: HTMLDivElement | null) => void
  highlightedRevealRowKey: string | null
  dragOverStatus: WorkspaceStatus | null
  pinDragOver: boolean
  toggleGroupWithScrollAnchor: (key: string) => void
  handleWorkspacePinDragOver: (event: React.DragEvent<HTMLElement>) => void
  handleWorkspacePinDragLeave: (event: React.DragEvent<HTMLElement>) => void
  handleWorkspaceStatusDragOver: (
    event: React.DragEvent<HTMLElement>,
    status: WorkspaceStatus
  ) => void
  handleWorkspaceStatusDragLeave: (event: React.DragEvent<HTMLElement>) => void
  handleWorkspaceStatusDrop: (event: React.DragEvent<HTMLElement>, status: WorkspaceStatus) => void
  handleRepoHeaderPointerDown: (event: React.PointerEvent<HTMLElement>, repoId: string) => void
  handleProjectGroupHeaderPointerDown: (
    event: React.PointerEvent<HTMLElement>,
    groupId: string
  ) => void
  projectGroups: readonly ProjectGroup[]
  handleCreateForRepo: (projectId: string) => void
  handleOpenRepoSettings: (projectId: string, sectionId?: string) => void
  handleOpenWorktreeVisibility: (repo: Repo) => void
  handleRemoveProject: (repo: Repo) => void
  handleCreateGroupFromRepo: (repo: Repo) => void
  handleMoveProjectToGroup: (repo: Repo, groupId: string) => void
  handleRemoveProjectFromGroup: (repo: Repo) => void
  handleRenameProjectGroup: (groupId: string, currentName: string) => void
  handleDeleteProjectGroup: (groupId: string, groupName: string) => void
  handleCreateFolderWorkspace: (projectGroup: ProjectGroup) => void
}

export function WorktreeListSectionHeader(props: WorktreeListSectionHeaderProps) {
  const { row, virtualItem, model } = props
  const {
    isActiveStickyHeader,
    stickyTopClass,
    hasHeaderTopSpacing,
    projectIdForHeader,
    projectGroupIdForHeader,
    repoHeaderIndex,
    repoHeaderBucketKey,
    repoHeaderSectionEnd,
    projectGroupHeaderIndex,
    projectGroupHeaderBucketKey,
    projectGroupHeaderSectionEnd,
    isDraggableRepoHeader,
    isDraggableProjectGroupHeader,
    isDraggingThis,
    isDraggingThisProjectGroup,
    headerWorkspaceStatus,
    isPinnedHeader,
    repoHeaderColor,
    createState,
    projectGroupPathStatus,
    folderWorkspaceCreateDisabled,
    isHeaderCollapsed,
    showHeaderCollapseAffordance,
    headerPaddingLeft
  } = model

  return (
    <div
      role="presentation"
      data-worktree-virtual-row
      data-worktree-virtual-row-key={String(virtualItem.key)}
      data-worktree-virtual-row-start={virtualItem.start}
      data-worktree-sticky-header=""
      data-worktree-sticky-header-active={isActiveStickyHeader ? '' : undefined}
      data-index={virtualItem.index}
      ref={props.measureVirtualRowElement}
      className={cn(
        'left-0 right-0',
        // Why: drop the inter-group spacer once the header pins so it sits flush at top (see getActiveStickyHeaderIndexForScroll).
        hasHeaderTopSpacing && !isActiveStickyHeader && 'pt-1',
        isActiveStickyHeader
          ? cn('sticky z-20 bg-worktree-sidebar', stickyTopClass)
          : 'absolute top-0'
      )}
      style={
        isActiveStickyHeader ? undefined : { transform: getVirtualRowTransform(virtualItem.start) }
      }
    >
      <div
        id={getWorktreeOptionId(row.key)}
        role="button"
        tabIndex={0}
        aria-expanded={showHeaderCollapseAffordance ? !isHeaderCollapsed : undefined}
        data-repo-header-id={projectIdForHeader}
        data-repo-header-index={repoHeaderIndex}
        data-repo-header-bucket={repoHeaderBucketKey}
        data-repo-header-section-end={repoHeaderSectionEnd}
        // Why: row keeps handle attrs so indent/padding still arms drag; grab
        // cursor lives only on the title surface so … / + never inherit it.
        data-repo-header-drag-handle={isDraggableRepoHeader ? '' : undefined}
        data-project-group-header-id={projectGroupIdForHeader}
        data-project-group-header-index={projectGroupHeaderIndex}
        data-project-group-header-bucket={projectGroupHeaderBucketKey}
        data-project-group-header-section-end={projectGroupHeaderSectionEnd}
        data-project-group-header-drag-handle={isDraggableProjectGroupHeader ? '' : undefined}
        data-workspace-status-drop-target={headerWorkspaceStatus ? '' : undefined}
        data-workspace-status={headerWorkspaceStatus ?? undefined}
        data-workspace-pin-drop-target={isPinnedHeader ? '' : undefined}
        className={cn(
          // Why: no row-level grab — only the title surface below shows the hand;
          // actions use cursor-pointer so … / + never look reorderable.
          'group relative flex h-7 w-full items-center gap-1.5 pr-2 text-left transition-all',
          !(isDraggableRepoHeader || isDraggableProjectGroupHeader) && 'cursor-pointer',
          props.highlightedRevealRowKey === row.key &&
            'rounded-md bg-worktree-sidebar-accent ring-1 ring-worktree-sidebar-ring/50',
          (isDraggingThis || isDraggingThisProjectGroup) &&
            'bg-accent/80 ring-1 ring-ring/40 shadow-md rounded-md scale-[1.01]',
          headerWorkspaceStatus &&
            props.dragOverStatus === headerWorkspaceStatus &&
            'rounded-md bg-worktree-sidebar-accent ring-1 ring-worktree-sidebar-ring/40',
          isPinnedHeader &&
            props.pinDragOver &&
            'rounded-md bg-worktree-sidebar-accent ring-1 ring-worktree-sidebar-ring/40',
          row.repo && 'overflow-hidden'
        )}
        style={{ paddingLeft: headerPaddingLeft }}
        onDragOver={
          isPinnedHeader
            ? props.handleWorkspacePinDragOver
            : headerWorkspaceStatus
              ? (event) => props.handleWorkspaceStatusDragOver(event, headerWorkspaceStatus)
              : undefined
        }
        onDragLeave={
          isPinnedHeader
            ? props.handleWorkspacePinDragLeave
            : headerWorkspaceStatus
              ? props.handleWorkspaceStatusDragLeave
              : undefined
        }
        onDrop={
          headerWorkspaceStatus
            ? (event) => props.handleWorkspaceStatusDrop(event, headerWorkspaceStatus)
            : undefined
        }
        onPointerDown={
          isDraggableRepoHeader && projectIdForHeader
            ? (event) => props.handleRepoHeaderPointerDown(event, projectIdForHeader)
            : isDraggableProjectGroupHeader && projectGroupIdForHeader
              ? (event) => props.handleProjectGroupHeaderPointerDown(event, projectGroupIdForHeader)
              : undefined
        }
        onClick={(event) => {
          if (!shouldIgnoreRepoHeaderToggle(event)) {
            props.toggleGroupWithScrollAnchor(row.key)
          }
        }}
        onKeyDown={(event) => {
          if (shouldIgnoreRepoHeaderToggle(event)) {
            return
          }
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            props.toggleGroupWithScrollAnchor(row.key)
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
              <FolderWorkspacePathStatusIndicator status={projectGroupPathStatus} />
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
                props.toggleGroupWithScrollAnchor(row.key)
              }}
            >
              <ChevronDown
                className={cn('size-3.5 transition-transform', isHeaderCollapsed && '-rotate-90')}
              />
            </div>
          ) : null}
          {projectGroupIdForHeader ? (
            <WorktreeListProjectGroupHeaderActions
              row={row}
              projectGroupPathStatus={projectGroupPathStatus}
              folderWorkspaceCreateDisabled={folderWorkspaceCreateDisabled}
              onRenameProjectGroup={props.handleRenameProjectGroup}
              onDeleteProjectGroup={props.handleDeleteProjectGroup}
              onCreateFolderWorkspace={props.handleCreateFolderWorkspace}
            />
          ) : null}
          {projectIdForHeader && row.repo ? (
            <WorktreeListRepoHeaderActions
              repo={row.repo}
              label={row.label}
              createState={createState}
              projectGroups={props.projectGroups}
              onCreateForRepo={props.handleCreateForRepo}
              onOpenRepoSettings={props.handleOpenRepoSettings}
              onOpenWorktreeVisibility={props.handleOpenWorktreeVisibility}
              onRemoveProject={props.handleRemoveProject}
              onCreateGroupFromRepo={props.handleCreateGroupFromRepo}
              onMoveProjectToGroup={props.handleMoveProjectToGroup}
              onRemoveProjectFromGroup={props.handleRemoveProjectFromGroup}
            />
          ) : null}
        </ProjectHeaderActions>
      </div>
    </div>
  )
}
