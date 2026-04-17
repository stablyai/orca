import React, { useCallback, useEffect, useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  FolderOpen,
  Copy,
  Bell,
  BellOff,
  Link,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  XCircle,
  Trash2
} from 'lucide-react'
import { useAppStore } from '@/store'
import type { Worktree } from '../../../../shared/types'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { runWorktreeDeleteWithToast } from './delete-worktree-flow'

type Props = {
  worktree: Worktree
  children: React.ReactNode
}

const CLOSE_ALL_CONTEXT_MENUS_EVENT = 'orca-close-all-context-menus'

const WorktreeContextMenu = React.memo(function WorktreeContextMenu({ worktree, children }: Props) {
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)
  const openModal = useAppStore((s) => s.openModal)
  const repos = useAppStore((s) => s.repos)
  const skipDeleteConfirm = useAppStore((s) => s.settings?.skipDeleteWorktreeConfirm ?? false)
  const shutdownWorktreeTerminals = useAppStore((s) => s.shutdownWorktreeTerminals)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const clearWorktreeDeleteState = useAppStore((s) => s.clearWorktreeDeleteState)
  const deleteState = useAppStore((s) => s.deleteStateByWorktreeId[worktree.id])
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPoint, setMenuPoint] = useState({ x: 0, y: 0 })
  const isDeleting = deleteState?.isDeleting ?? false
  const repo = repos.find((entry) => entry.id === worktree.repoId)
  const isFolder = repo ? isFolderRepo(repo) : false

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
      currentComment: worktree.comment,
      focus: 'displayName'
    })
  }, [worktree.id, worktree.displayName, worktree.linkedIssue, worktree.comment, openModal])

  const handleLinkIssue = useCallback(() => {
    openModal('edit-meta', {
      worktreeId: worktree.id,
      currentDisplayName: worktree.displayName,
      currentIssue: worktree.linkedIssue,
      currentComment: worktree.comment,
      focus: 'issue'
    })
  }, [worktree.id, worktree.displayName, worktree.linkedIssue, worktree.comment, openModal])

  const handleComment = useCallback(() => {
    openModal('edit-meta', {
      worktreeId: worktree.id,
      currentDisplayName: worktree.displayName,
      currentIssue: worktree.linkedIssue,
      currentComment: worktree.comment,
      focus: 'comment'
    })
  }, [worktree.id, worktree.displayName, worktree.linkedIssue, worktree.comment, openModal])

  const handleCloseTerminals = useCallback(async () => {
    // Why: shutting down the currently active worktree while its TerminalPane
    // is still visible causes a visible "reboot" flicker and can crash the
    // pane. clearTransientTerminalState nulls each tab's ptyId in place
    // without bumping generation, so TerminalPane stays mounted while its
    // PTYs are being killed; PTY exit callbacks then race against the live
    // xterm instance. Boot the user to the landing page FIRST so the visible
    // surface is detached before the async teardown runs.
    if (activeWorktreeId === worktree.id) {
      setActiveWorktree(null)
    }
    await shutdownWorktreeTerminals(worktree.id)
  }, [worktree.id, shutdownWorktreeTerminals, activeWorktreeId, setActiveWorktree])

  const handleDelete = useCallback(() => {
    setMenuOpen(false)
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
    clearWorktreeDeleteState(worktree.id)
    // Why: when the user has opted into skipping the confirmation, jump
    // straight to the same delete-with-toast flow the dialog would run on
    // confirm. The force-delete fallback still surfaces through the toast's
    // "Force Delete" action, so the user never silently loses dirty work —
    // they just skip the redundant "are you sure?" step for clean deletes.
    // The dialog stays the entry point for the main worktree (guarded at the
    // DropdownMenuItem level) and for any worktree that becomes unavailable
    // mid-action, because those cases produce dialog-specific UI.
    if (skipDeleteConfirm && !worktree.isMainWorktree) {
      runWorktreeDeleteWithToast(worktree.id, worktree.displayName)
      return
    }
    openModal('delete-worktree', { worktreeId: worktree.id })
  }, [
    worktree.id,
    worktree.repoId,
    worktree.displayName,
    worktree.isMainWorktree,
    clearWorktreeDeleteState,
    isFolder,
    openModal,
    skipDeleteConfirm
  ])

  return (
    <>
      <div
        className="relative"
        onContextMenuCapture={(event) => {
          event.preventDefault()
          window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
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
        <DropdownMenuContent className="w-52" sideOffset={0} align="start">
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
            {worktree.isUnread ? <BellOff className="size-3.5" /> : <Bell className="size-3.5" />}
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
          <DropdownMenuItem onSelect={handleCloseTerminals} disabled={isDeleting}>
            <XCircle className="size-3.5" />
            Shutdown
          </DropdownMenuItem>
          {/* Why: `git worktree remove` always rejects the main worktree, so we
             disable the item upfront. Radix forwards unknown props to the DOM
             element, so `title` works directly without a wrapper span — this
             preserves Radix's flat roving-tabindex keyboard navigation. */}
          <DropdownMenuItem
            variant="destructive"
            onSelect={handleDelete}
            disabled={isDeleting || (!isFolder && worktree.isMainWorktree)}
            title={
              !isFolder && worktree.isMainWorktree
                ? 'The main worktree cannot be deleted'
                : undefined
            }
          >
            <Trash2 className="size-3.5" />
            {isDeleting ? 'Deleting…' : isFolder ? 'Remove Folder from Orca' : 'Delete'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
})

export default WorktreeContextMenu
