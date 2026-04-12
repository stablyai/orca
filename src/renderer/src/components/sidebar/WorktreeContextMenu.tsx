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
  XCircle,
  Trash
} from 'lucide-react'
import { useAppStore } from '@/store'
import type { Worktree } from '../../../../shared/types'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { getWorktreeRemovalAction, openWorktreeRemovalModal } from './worktree-removal'

type Props = {
  worktree: Worktree
  children: React.ReactNode
}

const CLOSE_ALL_CONTEXT_MENUS_EVENT = 'orca-close-all-context-menus'

const WorktreeContextMenu = React.memo(function WorktreeContextMenu({ worktree, children }: Props) {
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)
  const openModal = useAppStore((s) => s.openModal)
  const repos = useAppStore((s) => s.repos)
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
  const removalAction = getWorktreeRemovalAction(worktree, isFolder)

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
    await shutdownWorktreeTerminals(worktree.id)
    if (activeWorktreeId === worktree.id) {
      setActiveWorktree(null)
    }
  }, [worktree.id, shutdownWorktreeTerminals, activeWorktreeId, setActiveWorktree])

  const handleDelete = useCallback(() => {
    setMenuOpen(false)
    openWorktreeRemovalModal(worktree, isFolder, openModal, clearWorktreeDeleteState)
  }, [clearWorktreeDeleteState, isFolder, openModal, worktree])

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
            disabled={isDeleting || removalAction.disabled}
            title={removalAction.disabledReason}
          >
            <Trash className="size-3.5" />
            {isDeleting ? 'Deleting…' : removalAction.label}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
})

export default WorktreeContextMenu
