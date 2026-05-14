import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  FolderOpen,
  Copy,
  Bell,
  BellOff,
  Link,
  MessageSquare,
  Moon,
  Pencil,
  Pin,
  PinOff,
  Trash2
} from 'lucide-react'
import { useAppStore } from '@/store'
import { useRepoById, useRepoMap } from '@/store/selectors'
import { cn } from '@/lib/utils'
import type { Worktree } from '../../../../shared/types'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { runWorktreeBatchDelete, runWorktreeDelete } from './delete-worktree-flow'
import { runSleepWorktrees } from './sleep-worktree-flow'

type Props = {
  worktree: Worktree
  children: React.ReactNode
  contentClassName?: string
  selectedWorktrees?: readonly Worktree[]
  onContextMenuSelect?: (event: React.MouseEvent<HTMLDivElement>) => readonly Worktree[]
}

const CLOSE_ALL_CONTEXT_MENUS_EVENT = 'orca-close-all-context-menus'
const WORKTREE_CONTEXT_MENU_SCOPE_ATTR = 'data-worktree-context-menu-scope'

const WorktreeContextMenu = React.memo(function WorktreeContextMenu({
  worktree,
  children,
  contentClassName,
  selectedWorktrees = [worktree],
  onContextMenuSelect
}: Props) {
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)
  const openModal = useAppStore((s) => s.openModal)
  const repo = useRepoById(worktree.repoId)
  const deleteState = useAppStore((s) => s.deleteStateByWorktreeId[worktree.id])
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPoint, setMenuPoint] = useState({ x: 0, y: 0 })
  const [contextWorktrees, setContextWorktrees] = useState<readonly Worktree[]>(selectedWorktrees)
  const isDeleting = deleteState?.isDeleting ?? false
  const isFolder = repo ? isFolderRepo(repo) : false
  const repoMap = useRepoMap()
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const ptyIdsByTabId = useAppStore((s) => s.ptyIdsByTabId)
  const browserTabsByWorktree = useAppStore((s) => s.browserTabsByWorktree)
  const deleteStateByWorktreeId = useAppStore((s) => s.deleteStateByWorktreeId)
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

  useEffect(() => {
    const closeMenu = (): void => setMenuOpen(false)
    window.addEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
    return () => window.removeEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
  }, [])

  const handleOpenInFinder = useCallback(() => {
    window.api.shell.openPath(worktree.path)
  }, [worktree.path])

  const handleCopyPath = useCallback(() => {
    window.api.ui.writeClipboardText(worktree.path)
  }, [worktree.path])

  const handleToggleRead = useCallback(() => {
    updateWorktreeMeta(worktree.id, { isUnread: !worktree.isUnread })
  }, [worktree.id, worktree.isUnread, updateWorktreeMeta])

  const handleTogglePin = useCallback(() => {
    updateWorktreeMeta(worktree.id, { isPinned: !worktree.isPinned })
  }, [worktree.id, worktree.isPinned, updateWorktreeMeta])

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

  return (
    <>
      <div
        className="relative"
        onContextMenuCapture={(event) => {
          const target = event.target
          if (
            target instanceof Element &&
            target.closest(`[${WORKTREE_CONTEXT_MENU_SCOPE_ATTR}]`)
          ) {
            return
          }
          event.preventDefault()
          window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
          setContextWorktrees(onContextMenuSelect?.(event) ?? selectedWorktrees)
          const bounds = event.currentTarget.getBoundingClientRect()
          setMenuPoint({ x: event.clientX - bounds.left, y: event.clientY - bounds.top })
          setMenuOpen(true)
        }}
      >
        {children}
      </div>

      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            aria-hidden
            tabIndex={-1}
            className="pointer-events-none absolute size-px opacity-0"
            style={{ left: menuPoint.x, top: menuPoint.y }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent className={cn('w-52', contentClassName)} sideOffset={0} align="start">
          {!isMultiContext && (
            <>
              <DropdownMenuItem onSelect={handleOpenInFinder} disabled={isDeleting}>
                <FolderOpen className="size-3.5" />
                Open in Finder
              </DropdownMenuItem>
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
            </>
          )}
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
    </>
  )
})

export default WorktreeContextMenu
export { CLOSE_ALL_CONTEXT_MENUS_EVENT, WORKTREE_CONTEXT_MENU_SCOPE_ATTR }
