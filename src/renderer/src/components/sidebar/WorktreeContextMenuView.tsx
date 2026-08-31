import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Copy,
  Bell,
  BellOff,
  CircleX,
  Pencil,
  Pin,
  PinOff,
  Trash2,
  Unlink,
  Workflow,
  FolderInput,
  FolderPlus,
  FolderTree
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { WorktreeOpenInSubMenu } from './WorktreeOpenInMenu'
import { WorktreeDeveloperMenu } from './WorktreeDeveloperMenu'
import { WorkspaceSleepMenuItems } from './WorkspaceSleepMenuItems'
import { isEventTargetInsideCurrentTarget } from './worktree-card-dom-events'
import { translate } from '@/i18n/i18n'
import { useOptionalShortcutLabel } from '@/hooks/useShortcutLabel'
import type { WorktreeContextMenuModel } from './use-worktree-context-menu-model'
import { WorktreeStatusMenuItems } from './WorktreeStatusMenuItems'
import { WorktreeContextMenuOverlays } from './WorktreeContextMenuOverlays'
import {
  CLOSE_ALL_CONTEXT_MENUS_EVENT,
  WORKTREE_CONTEXT_MENU_SCOPE_ATTR,
  getWorktreeParentPickerLabel,
  isWorktreeParentPickerDisabled,
  shouldIgnoreNestedWorktreeContextMenuScope,
  shouldRevealWorktreeDeveloperMenu,
  shouldUseNativeContextMenu
} from './worktree-context-menu-policy'

export default function WorktreeContextMenuView({ model }: { model: WorktreeContextMenuModel }) {
  const {
    batchDeleteWorktrees,
    children,
    contentClassName,
    contextDeletePending,
    contextMenuOpenedAtRef,
    contextWorkspaceStatus,
    deleteLabel,
    deletingContext,
    deletingSubtree,
    developerMenuRevealed,
    eligibleParentCount,
    effectiveSelectedWorktrees,
    folderWorkspaceId,
    handleAssignWorkspaceStatus,
    handleCloseAutoFocus,
    handleCloseTerminals,
    handleCopyPath,
    handleCreateGroupFromRepo,
    handleDelete,
    handleMoveProjectToGroup,
    handleOpenParent,
    handleOpenParentPicker,
    handleRemoveParentLink,
    handleRemoveProjectFromGroup,
    handleRename,
    handleSleepSubtree,
    handleTogglePin,
    handleToggleRead,
    hasAnyContextLineage,
    hasParentLink,
    isDeleting,
    isMultiContext,
    lineageDescendantCount,
    menuOpen,
    menuPoint,
    onContextMenuSelect,
    projectGroups,
    removesProject,
    repo,
    scopeRef,
    setContextWorktrees,
    setDeveloperMenuRevealed,
    setMenuOpenState,
    setMenuPoint,
    sleepLabel,
    sleepableWorktrees,
    subtreeSleepableWorktrees,
    suppressOpeningPointerEvent,
    validParentWorktreeId,
    worktree,
    workspaceStatuses
  } = model
  const deleteShortcut = useOptionalShortcutLabel('workspace.delete')
  return (
    <div
      ref={scopeRef}
      className="relative"
      {...{ [WORKTREE_CONTEXT_MENU_SCOPE_ATTR]: 'worktree' }}
      onContextMenuCapture={(event) => {
        if (!isEventTargetInsideCurrentTarget(event.currentTarget, event.target)) {
          return
        }
        if (shouldUseNativeContextMenu(event.target)) {
          return
        }
        if (shouldIgnoreNestedWorktreeContextMenuScope(event.currentTarget, event.target)) {
          return
        }
        event.preventDefault()
        contextMenuOpenedAtRef.current = Date.now()
        window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
        setDeveloperMenuRevealed(event.altKey)
        setContextWorktrees(onContextMenuSelect?.(event) ?? effectiveSelectedWorktrees)
        const bounds = event.currentTarget.getBoundingClientRect()
        setMenuPoint({ x: event.clientX - bounds.left, y: event.clientY - bounds.top })
        setMenuOpenState(true)
      }}
      onClickCapture={(event) => {
        suppressOpeningPointerEvent(event)
      }}
    >
      {children}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpenState} modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            aria-hidden
            tabIndex={-1}
            className="pointer-events-none absolute size-px opacity-0"
            style={{ left: menuPoint.x, top: menuPoint.y }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className={cn(lineageDescendantCount > 0 ? 'w-60' : 'w-52', contentClassName)}
          sideOffset={0}
          align="start"
          onPointerUpCapture={suppressOpeningPointerEvent}
          onPointerDownCapture={(event) => {
            if (event.button === 0) {
              contextMenuOpenedAtRef.current = null
            }
          }}
          onMouseUpCapture={suppressOpeningPointerEvent}
          onClickCapture={suppressOpeningPointerEvent}
          onCloseAutoFocus={handleCloseAutoFocus}
        >
          <DropdownMenuLabel className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
            {translate('auto.components.sidebar.WorktreeContextMenu.workspaceSection', 'Workspace')}
          </DropdownMenuLabel>
          {!isMultiContext && (
            <DropdownMenuItem onSelect={handleRename} disabled={isDeleting}>
              <Pencil className="size-3.5" />
              {translate('auto.components.sidebar.WorktreeContextMenu.439fa94d53', 'Update')}
            </DropdownMenuItem>
          )}
          <WorktreeStatusMenuItems
            contextWorkspaceStatus={contextWorkspaceStatus}
            deletingContext={deletingContext}
            isMultiContext={isMultiContext}
            onAssignWorkspaceStatus={handleAssignWorkspaceStatus}
            workspaceStatuses={workspaceStatuses}
          />
          <DropdownMenuSeparator />
          {!isMultiContext && (
            <>
              <WorktreeOpenInSubMenu
                worktreePath={worktree.path}
                connectionId={repo?.connectionId ?? null}
                disabled={isDeleting}
              />
              <DropdownMenuItem onSelect={handleCopyPath} disabled={isDeleting}>
                <Copy className="size-3.5" />
                {translate('auto.components.sidebar.WorktreeContextMenu.3350101edb', 'Copy Path')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={handleTogglePin} disabled={isDeleting}>
                {worktree.isPinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                {worktree.isPinned
                  ? translate('auto.components.sidebar.WorktreeContextMenu.697d0f6e1b', 'Unpin')
                  : translate('auto.components.sidebar.WorktreeContextMenu.3baa7d6507', 'Pin')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={handleToggleRead} disabled={isDeleting}>
                {worktree.isUnread ? (
                  <BellOff className="size-3.5" />
                ) : (
                  <Bell className="size-3.5" />
                )}
                {worktree.isUnread
                  ? translate('auto.components.sidebar.WorktreeContextMenu.8dacff1fe0', 'Mark Read')
                  : translate(
                      'auto.components.sidebar.WorktreeContextMenu.f50603c6b2',
                      'Mark Unread'
                    )}
              </DropdownMenuItem>
              {repo ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={handleCreateGroupFromRepo} disabled={isDeleting}>
                    <FolderPlus className="size-3.5" />
                    {translate(
                      'auto.components.sidebar.WorktreeContextMenu.503ec0f8e6',
                      'New group from project'
                    )}
                  </DropdownMenuItem>
                  {projectGroups.length > 0 ? (
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger disabled={isDeleting}>
                        <FolderInput className="size-3.5" />
                        {translate(
                          'auto.components.sidebar.WorktreeContextMenu.76865d827f',
                          'Move to group'
                        )}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent>
                        {projectGroups.map((group) => (
                          <DropdownMenuItem
                            key={group.id}
                            disabled={repo.projectGroupId === group.id}
                            onSelect={() => handleMoveProjectToGroup(group.id)}
                          >
                            <span className="max-w-48 truncate">{group.name}</span>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  ) : null}
                  {repo.projectGroupId ? (
                    <DropdownMenuItem onSelect={handleRemoveProjectFromGroup} disabled={isDeleting}>
                      <CircleX className="size-3.5" />
                      {translate(
                        'auto.components.sidebar.WorktreeContextMenu.d35dfeae58',
                        'Remove from group'
                      )}
                    </DropdownMenuItem>
                  ) : null}
                </>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={handleOpenParentPicker}
                disabled={isWorktreeParentPickerDisabled({ isDeleting, eligibleParentCount })}
              >
                <FolderTree className="size-3.5" />
                {getWorktreeParentPickerLabel(validParentWorktreeId)}
              </DropdownMenuItem>
              {(validParentWorktreeId || hasParentLink) && (
                <>
                  {validParentWorktreeId && (
                    <DropdownMenuItem onSelect={handleOpenParent} disabled={isDeleting}>
                      <Workflow className="size-3.5" />
                      {translate(
                        'auto.components.sidebar.WorktreeContextMenu.8d9cd19d09',
                        'Open Parent Worktree'
                      )}
                    </DropdownMenuItem>
                  )}
                  {hasParentLink && (
                    <DropdownMenuItem onSelect={handleRemoveParentLink} disabled={isDeleting}>
                      <Unlink className="size-3.5" />
                      {translate(
                        'auto.components.sidebar.WorktreeContextMenu.579b1a8e61',
                        'Remove from Parent'
                      )}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                </>
              )}
            </>
          )}
          {isMultiContext && hasAnyContextLineage ? (
            <>
              <DropdownMenuItem onSelect={handleRemoveParentLink} disabled={deletingContext}>
                <Unlink className="size-3.5" />
                {translate(
                  'auto.components.sidebar.WorktreeContextMenu.579b1a8e61',
                  'Remove from Parent'
                )}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}

          {shouldRevealWorktreeDeveloperMenu({ developerMenuRevealed, isMultiContext }) ? (
            <>
              <WorktreeDeveloperMenu worktreeId={worktree.id} disabled={isDeleting} />
              <DropdownMenuSeparator />
            </>
          ) : null}
          <WorkspaceSleepMenuItems
            isMultiContext={isMultiContext}
            sleepLabel={sleepLabel}
            sleepDisabled={deletingContext || sleepableWorktrees.length === 0}
            descendantCount={lineageDescendantCount}
            subtreeSleepDisabled={deletingSubtree || subtreeSleepableWorktrees.length === 0}
            onSleep={handleCloseTerminals}
            onSleepSubtree={handleSleepSubtree}
          />
          {/* Why: primary checkout rows can't be git-worktree-removed, so keep a
             disabled Delete Worktree for parity with non-primary cards and pair
             it with the enabled Remove Project action below. */}
          {!isMultiContext && removesProject ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <div>
                  <DropdownMenuItem variant="destructive" disabled>
                    <Trash2 className="size-3.5" />
                    {translate(
                      'auto.components.sidebar.WorktreeContextMenu.deleteWorktree',
                      'Delete Worktree'
                    )}
                  </DropdownMenuItem>
                </div>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={8} className="max-w-[200px] text-pretty">
                {translate(
                  'auto.components.sidebar.WorktreeContextMenu.primaryDeleteDisabled',
                  "Primary worktree — can't be deleted. Remove the project instead."
                )}
              </TooltipContent>
            </Tooltip>
          ) : null}
          {/* Why: primary checkout rows remove the project from Orca instead of
             invoking git worktree deletion. Radix forwards unknown props to the
             DOM element, so `title` works directly without a wrapper span —
             this preserves Radix's flat roving-tabindex keyboard navigation. */}
          <DropdownMenuItem
            variant="destructive"
            onSelect={handleDelete}
            disabled={
              contextDeletePending ||
              (!isMultiContext && worktree.isMainWorktree && !removesProject) ||
              (isMultiContext && batchDeleteWorktrees.length === 0)
            }
            title={
              !isMultiContext && worktree.isMainWorktree && !removesProject
                ? translate(
                    'auto.components.sidebar.WorktreeContextMenu.e091caab15',
                    'The project could not be found'
                  )
                : undefined
            }
          >
            <Trash2 className="size-3.5" />
            {contextDeletePending
              ? translate('auto.components.sidebar.WorktreeContextMenu.b42391d8bf', 'Deleting…')
              : isMultiContext
                ? deleteLabel
                : folderWorkspaceId
                  ? translate(
                      'auto.components.sidebar.WorktreeContextMenu.250de158fd',
                      'Remove Workspace'
                    )
                  : removesProject
                    ? translate(
                        'auto.components.sidebar.WorktreeContextMenu.f5ac91531d',
                        'Remove Project from Orca'
                      )
                    : lineageDescendantCount > 0
                      ? translate(
                          'auto.components.sidebar.WorktreeContextMenu.deleteWithDescendants',
                          'Delete with Descendants…'
                        )
                      : translate(
                          'auto.components.sidebar.WorktreeContextMenu.f4475537d8',
                          'Delete'
                        )}
            {!isMultiContext && !removesProject && deleteShortcut ? (
              <DropdownMenuShortcut>{deleteShortcut}</DropdownMenuShortcut>
            ) : null}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <WorktreeContextMenuOverlays model={model} />
    </div>
  )
}
