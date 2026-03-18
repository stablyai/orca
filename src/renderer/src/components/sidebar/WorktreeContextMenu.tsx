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
  Eye,
  EyeOff,
  Link,
  MessageSquare,
  XCircle,
  Archive,
  Trash2
} from 'lucide-react'
import { useAppStore } from '@/store'
import type { Worktree } from '../../../../shared/types'

interface Props {
  worktree: Worktree
  children: React.ReactNode
}

const CLOSE_ALL_CONTEXT_MENUS_EVENT = 'orca-close-all-context-menus'

const WorktreeContextMenu = React.memo(function WorktreeContextMenu({ worktree, children }: Props) {
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)
  const removeWorktree = useAppStore((s) => s.removeWorktree)
  const openModal = useAppStore((s) => s.openModal)
  const closeTab = useAppStore((s) => s.closeTab)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPoint, setMenuPoint] = useState({ x: 0, y: 0 })

  useEffect(() => {
    const closeMenu = (): void => setMenuOpen(false)
    window.addEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
    return () => window.removeEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
  }, [])

  const handleOpenInFinder = useCallback(() => {
    window.api.shell.openPath(worktree.path)
  }, [worktree.path])

  const handleCopyPath = useCallback(() => {
    navigator.clipboard.writeText(worktree.path)
  }, [worktree.path])

  const handleToggleRead = useCallback(() => {
    updateWorktreeMeta(worktree.id, { isUnread: !worktree.isUnread })
  }, [worktree.id, worktree.isUnread, updateWorktreeMeta])

  const handleLinkIssue = useCallback(() => {
    openModal('link-issue', { worktreeId: worktree.id, currentIssue: worktree.linkedIssue })
  }, [worktree.id, worktree.linkedIssue, openModal])

  const handleComment = useCallback(() => {
    openModal('edit-comment', { worktreeId: worktree.id, currentComment: worktree.comment })
  }, [worktree.id, worktree.comment, openModal])

  const handleCloseTerminals = useCallback(() => {
    const tabs = useAppStore.getState().tabsByWorktree[worktree.id] ?? []
    for (const tab of tabs) {
      if (tab.ptyId) {
        window.api.pty.kill(tab.ptyId)
      }
      closeTab(tab.id)
    }
  }, [worktree.id, closeTab])

  const handleArchive = useCallback(() => {
    updateWorktreeMeta(worktree.id, { isArchived: true })
  }, [worktree.id, updateWorktreeMeta])

  const handleDelete = useCallback(() => {
    removeWorktree(worktree.id)
  }, [worktree.id, removeWorktree])

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
          <DropdownMenuItem onSelect={handleOpenInFinder}>
            <FolderOpen className="size-3.5" />
            Open in Finder
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleCopyPath}>
            <Copy className="size-3.5" />
            Copy Path
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={handleToggleRead}>
            {worktree.isUnread ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
            {worktree.isUnread ? 'Mark Read' : 'Mark Unread'}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleLinkIssue}>
            <Link className="size-3.5" />
            {worktree.linkedIssue ? 'Edit GH Issue' : 'Link GH Issue'}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleComment}>
            <MessageSquare className="size-3.5" />
            {worktree.comment ? 'Edit Comment' : 'Add Comment'}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={handleCloseTerminals}>
            <XCircle className="size-3.5" />
            Close Terminals
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleArchive}>
            <Archive className="size-3.5" />
            Archive
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={handleDelete}>
            <Trash2 className="size-3.5" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
})

export default WorktreeContextMenu
