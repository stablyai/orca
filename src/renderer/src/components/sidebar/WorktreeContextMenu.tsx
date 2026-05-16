/* eslint-disable max-lines -- Why: this menu keeps row targeting, batch actions, and ctrl-click event guards together so nested worktree menus share one event policy. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
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
  Link,
  MessageSquare,
  Moon,
  Pencil,
  Pin,
  PinOff,
  Kanban,
  Trash2,
  Unlink,
  Workflow
} from 'lucide-react'
import { useAppStore } from '@/store'
import { useRepoById, useRepoMap, useWorktreeMap } from '@/store/selectors'
import { cn } from '@/lib/utils'
import type { Worktree } from '../../../../shared/types'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { runWorktreeBatchDelete, runWorktreeDelete } from './delete-worktree-flow'
import { runSleepWorktrees } from './sleep-worktree-flow'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { getLineageRenderInfo } from './worktree-list-groups'
import { getWorkspaceStatus, getWorkspaceStatusVisualMeta } from './workspace-status'
import { WorktreeOpenInSubMenu } from './WorktreeOpenInMenu'

type Props = {
  worktree: Worktree
  children: React.ReactNode
  contentClassName?: string
  selectedWorktrees?: readonly Worktree[]
  onContextMenuSelect?: (event: React.MouseEvent<HTMLElement>) => readonly Worktree[]
}

const CLOSE_ALL_CONTEXT_MENUS_EVENT = 'orca-close-all-context-menus'
const WORKTREE_CONTEXT_MENU_SCOPE_ATTR = 'data-worktree-context-menu-scope'
const CONTEXT_MENU_CLICK_SUPPRESSION_MS = 500

function shouldIgnoreNestedWorktreeContextMenuScope(
  currentTarget: EventTarget,
  target: EventTarget | null
): boolean {
  const maybeScopedTarget = target as {
    closest?: (selector: string) => Element | null
    parentElement?: { closest?: (selector: string) => Element | null }
  } | null
  const scopeSelector = `[${WORKTREE_CONTEXT_MENU_SCOPE_ATTR}]`
  const closestScope =
    maybeScopedTarget?.closest?.(scopeSelector) ??
    maybeScopedTarget?.parentElement?.closest?.(scopeSelector)
  // Why: lineage child previews live inside the parent card DOM but own their
  // context menu target. The parent must ignore only those nested scopes.
  return closestScope != null && closestScope !== currentTarget
}

function shouldSuppressContextMenuFollowUpClick(contextMenuOpenedAt: number, now: number): boolean {
  return (
    now - contextMenuOpenedAt >= 0 && now - contextMenuOpenedAt <= CONTEXT_MENU_CLICK_SUPPRESSION_MS
  )
}

const WorktreeContextMenu = React.memo(function WorktreeContextMenu({
  worktree,
  children,
  contentClassName,
  selectedWorktrees = [worktree],
  onContextMenuSelect
}: Props) {
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)
  const workspaceStatuses = useAppStore((s) => s.workspaceStatuses)
  const openModal = useAppStore((s) => s.openModal)
  const repo = useRepoById(worktree.repoId)
  const deleteState = useAppStore((s) => s.deleteStateByWorktreeId[worktree.id])
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPoint, setMenuPoint] = useState({ x: 0, y: 0 })
  const [contextWorktrees, setContextWorktrees] = useState<readonly Worktree[]>(selectedWorktrees)
  const isDeleting = deleteState?.isDeleting ?? false
  const isFolder = repo ? isFolderRepo(repo) : false
  const repoMap = useRepoMap()
  const worktreeMap = useWorktreeMap()
  const worktreeLineageById = useAppStore((s) => s.worktreeLineageById)
  const updateWorktreeLineage = useAppStore((s) => s.updateWorktreeLineage)
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const ptyIdsByTabId = useAppStore((s) => s.ptyIdsByTabId)
  const browserTabsByWorktree = useAppStore((s) => s.browserTabsByWorktree)
  const deleteStateByWorktreeId = useAppStore((s) => s.deleteStateByWorktreeId)
  const contextMenuOpenedAtRef = useRef<number | null>(null)
  const activeContextWorktrees = menuOpen ? contextWorktrees : selectedWorktrees
  const isMultiContext = activeContextWorktrees.length > 1
  const sleepableWorktrees = useMemo(
    () =>
      activeContextWorktrees.filter((item) => {
        const tabs = tabsByWorktree[item.id] ?? []
        const hasLiveTerminal = tabs.some((tab) => ptyIdsByTabId[tab.id] != null)
        const hasBrowser = (browserTabsByWorktree[item.id] ?? []).length > 0
        return hasLiveTerminal || hasBrowser
      }),
    [activeContextWorktrees, browserTabsByWorktree, ptyIdsByTabId, tabsByWorktree]
  )
  const deletingContext = useMemo(
    () => activeContextWorktrees.some((item) => deleteStateByWorktreeId[item.id]?.isDeleting),
    [activeContextWorktrees, deleteStateByWorktreeId]
  )
  const contextWorkspaceStatus = useMemo(() => {
    const [first, ...rest] = activeContextWorktrees
    if (!first) {
      return ''
    }
    const status = getWorkspaceStatus(first, workspaceStatuses)
    return rest.every((item) => getWorkspaceStatus(item, workspaceStatuses) === status)
      ? status
      : ''
  }, [activeContextWorktrees, workspaceStatuses])
  const batchDeleteWorktrees = useMemo(
    () =>
      activeContextWorktrees.filter((item) => {
        const itemRepo = repoMap.get(item.repoId)
        return !item.isMainWorktree && itemRepo != null && !isFolderRepo(itemRepo)
      }),
    [activeContextWorktrees, repoMap]
  )
  const sleepLabel =
    isMultiContext && sleepableWorktrees.length > 0
      ? `Sleep ${sleepableWorktrees.length} Workspace${sleepableWorktrees.length === 1 ? '' : 's'}`
      : 'Sleep'
  const deleteLabel =
    isMultiContext && batchDeleteWorktrees.length > 0
      ? `Delete ${batchDeleteWorktrees.length} Workspace${batchDeleteWorktrees.length === 1 ? '' : 's'}`
      : 'Delete Selected'
  const lineage = worktreeLineageById[worktree.id]
  // Why: path-derived worktree IDs can be reused. The menu must honor the same
  // instance check as grouped rows before offering navigation to a parent.
  const lineageInfo = useMemo(
    () => getLineageRenderInfo(worktree, worktreeLineageById, worktreeMap),
    [worktree, worktreeLineageById, worktreeMap]
  )
  const validParentWorktreeId = lineageInfo.state === 'valid' ? lineageInfo.parent.id : null
  const hasAnyContextLineage = activeContextWorktrees.some((item) => worktreeLineageById[item.id])

  useEffect(() => {
    const closeMenu = (): void => setMenuOpen(false)
    window.addEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
    return () => window.removeEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
  }, [])

  const handleCopyPath = useCallback(() => {
    window.api.ui.writeClipboardText(worktree.path)
  }, [worktree.path])

  const handleToggleRead = useCallback(() => {
    updateWorktreeMeta(worktree.id, { isUnread: !worktree.isUnread })
  }, [worktree.id, worktree.isUnread, updateWorktreeMeta])

  const handleTogglePin = useCallback(() => {
    updateWorktreeMeta(worktree.id, { isPinned: !worktree.isPinned })
  }, [worktree.id, worktree.isPinned, updateWorktreeMeta])

  const handleAssignWorkspaceStatus = useCallback(
    (status: string) => {
      setMenuOpen(false)
      void Promise.all(
        activeContextWorktrees.map((item) =>
          getWorkspaceStatus(item, workspaceStatuses) === status
            ? Promise.resolve()
            : updateWorktreeMeta(item.id, { workspaceStatus: status })
        )
      )
    },
    [activeContextWorktrees, updateWorktreeMeta, workspaceStatuses]
  )

  const handleRename = useCallback(() => {
    openModal('edit-meta', {
      worktreeId: worktree.id,
      currentDisplayName: worktree.displayName,
      currentIssue: worktree.linkedIssue,
      currentPR: worktree.linkedPR,
      currentComment: worktree.comment,
      focus: 'displayName'
    })
  }, [
    worktree.id,
    worktree.displayName,
    worktree.linkedIssue,
    worktree.linkedPR,
    worktree.comment,
    openModal
  ])

  const handleLinkIssue = useCallback(() => {
    openModal('edit-meta', {
      worktreeId: worktree.id,
      currentDisplayName: worktree.displayName,
      currentIssue: worktree.linkedIssue,
      currentPR: worktree.linkedPR,
      currentComment: worktree.comment,
      focus: 'issue'
    })
  }, [
    worktree.id,
    worktree.displayName,
    worktree.linkedIssue,
    worktree.linkedPR,
    worktree.comment,
    openModal
  ])

  const handleComment = useCallback(() => {
    openModal('edit-meta', {
      worktreeId: worktree.id,
      currentDisplayName: worktree.displayName,
      currentIssue: worktree.linkedIssue,
      currentPR: worktree.linkedPR,
      currentComment: worktree.comment,
      focus: 'comment'
    })
  }, [
    worktree.id,
    worktree.displayName,
    worktree.linkedIssue,
    worktree.linkedPR,
    worktree.comment,
    openModal
  ])

  const handleCloseTerminals = useCallback(async () => {
    await runSleepWorktrees(sleepableWorktrees.map((item) => item.id))
  }, [sleepableWorktrees])

  const handleDelete = useCallback(() => {
    // Folder mode handled inline because it routes to a different modal;
    // standard delete delegates to the shared runWorktreeDelete helper.
    setMenuOpen(false)
    if (isMultiContext) {
      runWorktreeBatchDelete(batchDeleteWorktrees.map((item) => item.id))
      return
    }
    if (isFolder) {
      // Why: folder mode reuses the worktree row UI for a synthetic root entry,
      // but users still expect "remove" to disconnect the folder from Orca,
      // not to run git-style delete semantics against the real folder on disk.
      openModal('confirm-remove-folder', {
        repoId: worktree.repoId,
        displayName: worktree.displayName
      })
      return
    }
    // Why delegate to runWorktreeDelete: keeps the skip-confirm vs. modal
    // decision tree (and its rationale) in one place shared with the memory
    // popover's inline Delete action. Folder mode short-circuits above
    // because the confirm-remove-folder modal is unique to this caller.
    runWorktreeDelete(worktree.id)
  }, [
    batchDeleteWorktrees,
    isFolder,
    isMultiContext,
    openModal,
    worktree.displayName,
    worktree.id,
    worktree.repoId
  ])

  const handleOpenParent = useCallback(() => {
    if (validParentWorktreeId) {
      activateAndRevealWorktree(validParentWorktreeId)
    }
  }, [validParentWorktreeId])

  const handleRemoveParentLink = useCallback(() => {
    void Promise.all(
      activeContextWorktrees.map((item) => updateWorktreeLineage(item.id, { noParent: true }))
    )
  }, [activeContextWorktrees, updateWorktreeLineage])

  const suppressOpeningPointerEvent = useCallback((event: React.SyntheticEvent) => {
    const contextMenuOpenedAt = contextMenuOpenedAtRef.current
    if (
      contextMenuOpenedAt == null ||
      !shouldSuppressContextMenuFollowUpClick(contextMenuOpenedAt, Date.now())
    ) {
      if (contextMenuOpenedAt != null) {
        contextMenuOpenedAtRef.current = null
      }
      return
    }
    // Why: macOS ctrl-click can release over the just-opened menu, selecting
    // the item under the cursor unless the opening pointer sequence is ignored.
    event.preventDefault()
    event.stopPropagation()
    if (event.type === 'click') {
      contextMenuOpenedAtRef.current = null
    }
  }, [])

  return (
    <div
      className="relative"
      {...{ [WORKTREE_CONTEXT_MENU_SCOPE_ATTR]: 'worktree' }}
      onContextMenuCapture={(event) => {
        if (shouldIgnoreNestedWorktreeContextMenuScope(event.currentTarget, event.target)) {
          return
        }
        event.preventDefault()
        contextMenuOpenedAtRef.current = Date.now()
        window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
        setContextWorktrees(onContextMenuSelect?.(event) ?? selectedWorktrees)
        const bounds = event.currentTarget.getBoundingClientRect()
        setMenuPoint({ x: event.clientX - bounds.left, y: event.clientY - bounds.top })
        setMenuOpen(true)
      }}
      onClickCapture={(event) => {
        suppressOpeningPointerEvent(event)
      }}
    >
      {children}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            aria-hidden
            tabIndex={-1}
            className="pointer-events-none absolute size-px opacity-0"
            style={{ left: menuPoint.x, top: menuPoint.y }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className={cn('w-52', contentClassName)}
          sideOffset={0}
          align="start"
          onPointerUpCapture={suppressOpeningPointerEvent}
          onMouseUpCapture={suppressOpeningPointerEvent}
          onClickCapture={suppressOpeningPointerEvent}
        >
          {!isMultiContext && (
            <>
              <WorktreeOpenInSubMenu
                worktreePath={worktree.path}
                connectionId={repo?.connectionId ?? null}
                disabled={isDeleting}
              />
              <DropdownMenuItem onSelect={handleCopyPath} disabled={isDeleting}>
                <Copy className="size-3.5" />
                Copy Path
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={handleTogglePin} disabled={isDeleting}>
                {worktree.isPinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                {worktree.isPinned ? 'Unpin' : 'Pin'}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={handleRename} disabled={isDeleting}>
                <Pencil className="size-3.5" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={handleToggleRead} disabled={isDeleting}>
                {worktree.isUnread ? (
                  <BellOff className="size-3.5" />
                ) : (
                  <Bell className="size-3.5" />
                )}
                {worktree.isUnread ? 'Mark Read' : 'Mark Unread'}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={handleLinkIssue} disabled={isDeleting}>
                <Link className="size-3.5" />
                {worktree.linkedIssue ? 'Edit GH Issue' : 'Link GH Issue'}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={handleComment} disabled={isDeleting}>
                <MessageSquare className="size-3.5" />
                {worktree.comment ? 'Edit Comment' : 'Add Comment'}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={handleOpenParent}
                disabled={isDeleting || !validParentWorktreeId}
              >
                <Workflow className="size-3.5" />
                Open Parent Workspace
              </DropdownMenuItem>
              {lineage && (
                <DropdownMenuItem onSelect={handleRemoveParentLink} disabled={isDeleting}>
                  <Unlink className="size-3.5" />
                  Remove from Parent
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
            </>
          )}
          {isMultiContext && (
            <>
              {hasAnyContextLineage && (
                <DropdownMenuItem onSelect={handleRemoveParentLink} disabled={deletingContext}>
                  <Unlink className="size-3.5" />
                  Remove from Parent
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={deletingContext}>
              <Kanban className="size-3.5" />
              {isMultiContext ? 'Move Statuses To' : 'Move to Status'}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-44">
              <DropdownMenuRadioGroup value={contextWorkspaceStatus}>
                {workspaceStatuses.map((status) => {
                  const meta = getWorkspaceStatusVisualMeta(status)
                  return (
                    <DropdownMenuRadioItem
                      key={status.id}
                      value={status.id}
                      onSelect={() => handleAssignWorkspaceStatus(status.id)}
                    >
                      <meta.icon className={cn('size-3.5', meta.tone)} />
                      {status.label}
                    </DropdownMenuRadioItem>
                  )
                })}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuItem
                onSelect={handleCloseTerminals}
                disabled={deletingContext || sleepableWorktrees.length === 0}
              >
                <Moon className="size-3.5" />
                {sleepLabel}
              </DropdownMenuItem>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8} className="max-w-[200px] text-pretty">
              {isMultiContext
                ? 'Close all active panels in the selected workspaces to free up memory and CPU.'
                : 'Close all active panels in this workspace to free up memory and CPU.'}
            </TooltipContent>
          </Tooltip>
          {/* Why: `git worktree remove` always rejects the main worktree, so we
             disable the item upfront. Radix forwards unknown props to the DOM
             element, so `title` works directly without a wrapper span — this
             preserves Radix's flat roving-tabindex keyboard navigation. */}
          <DropdownMenuItem
            variant="destructive"
            onSelect={handleDelete}
            disabled={
              deletingContext ||
              (!isMultiContext && !isFolder && worktree.isMainWorktree) ||
              (isMultiContext && batchDeleteWorktrees.length === 0)
            }
            title={
              !isMultiContext && !isFolder && worktree.isMainWorktree
                ? 'The main worktree cannot be deleted'
                : undefined
            }
          >
            <Trash2 className="size-3.5" />
            {deletingContext
              ? 'Deleting…'
              : isMultiContext
                ? deleteLabel
                : isFolder
                  ? 'Remove Folder from Orca'
                  : 'Delete'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
})

export default WorktreeContextMenu
export {
  CLOSE_ALL_CONTEXT_MENUS_EVENT,
  WORKTREE_CONTEXT_MENU_SCOPE_ATTR,
  shouldSuppressContextMenuFollowUpClick,
  shouldIgnoreNestedWorktreeContextMenuScope
}
