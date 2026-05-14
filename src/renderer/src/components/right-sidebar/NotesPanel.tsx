import { useCallback, useEffect, useRef, useState } from 'react'
import { Copy, FileText, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useAppStore } from '@/store'
import { useActiveWorktree, useRepoById } from '@/store/selectors'
import { cn } from '@/lib/utils'
import { getProjectNotesEntityId, openProjectNotesTab } from '@/lib/open-project-notes-tab'
import { NOTES_ACTIVE_CHANGED_EVENT } from '@/lib/notes-events'
import type { NoteSummary } from '../../../../shared/notes-types'

export default function NotesPanel(): React.JSX.Element {
  const activeWorktree = useActiveWorktree()
  const repo = useRepoById(activeWorktree?.repoId ?? null)
  const projectId = repo?.id ?? activeWorktree?.repoId ?? null
  const worktreeId = activeWorktree?.id ?? null

  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [renamingNoteId, setRenamingNoteId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<NoteSummary | null>(null)
  const [deleting, setDeleting] = useState(false)
  const renameCommittedRef = useRef(false)
  const deleteConfirmButtonRef = useRef<HTMLButtonElement>(null)

  const refresh = useCallback(async (): Promise<void> => {
    if (!projectId || !worktreeId) {
      setNotes([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      const result = await window.api.notes.list({ projectId, worktreeId, limit: 100 })
      setNotes(result.notes)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [projectId, worktreeId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const listener = (): void => {
      void refresh()
    }
    window.addEventListener(NOTES_ACTIVE_CHANGED_EVENT, listener)
    return () => window.removeEventListener(NOTES_ACTIVE_CHANGED_EVENT, listener)
  }, [refresh])

  const openNotes = useCallback(() => {
    if (!worktreeId) {
      return
    }
    void openProjectNotesTab(worktreeId)
  }, [worktreeId])

  const selectNote = useCallback(
    async (noteId: string): Promise<void> => {
      if (!projectId || !worktreeId) {
        return
      }
      await openProjectNotesTab(worktreeId, noteId)
      await refresh()
    },
    [projectId, refresh, worktreeId]
  )

  const startRename = useCallback((note: NoteSummary) => {
    renameCommittedRef.current = false
    setRenamingNoteId(note.id)
    setRenameValue(note.title)
  }, [])

  const commitRename = useCallback(
    async (note: NoteSummary): Promise<void> => {
      if (renameCommittedRef.current) {
        return
      }
      renameCommittedRef.current = true
      const title = renameValue.trim()
      setRenamingNoteId(null)
      if (!projectId || !worktreeId || !title || title === note.title) {
        return
      }
      try {
        const result = await window.api.notes.rename({
          projectId,
          worktreeId,
          note: note.id,
          title
        })
        const entityId = getProjectNotesEntityId(projectId, note.id)
        const state = useAppStore.getState()
        for (const tabs of Object.values(state.unifiedTabsByWorktree)) {
          for (const tab of tabs) {
            if (tab.contentType === 'notes' && tab.entityId === entityId) {
              state.setTabLabel(tab.id, result.note.title)
            }
          }
        }
        await refresh()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : `Failed to rename '${note.title}'.`)
      }
    },
    [projectId, refresh, renameValue, worktreeId]
  )

  const cancelRename = useCallback(() => {
    renameCommittedRef.current = true
    setRenamingNoteId(null)
  }, [])

  const confirmDeleteNote = useCallback(async (): Promise<void> => {
    if (!projectId || !worktreeId || !deleteTarget || deleting) {
      return
    }
    setDeleting(true)
    try {
      await window.api.notes.delete({ projectId, worktreeId, note: deleteTarget.id })
      const entityId = getProjectNotesEntityId(projectId, deleteTarget.id)
      const state = useAppStore.getState()
      const tabIdsToClose: string[] = []
      for (const tabs of Object.values(state.unifiedTabsByWorktree)) {
        for (const tab of tabs) {
          if (tab.contentType === 'notes' && tab.entityId === entityId) {
            tabIdsToClose.push(tab.id)
          }
        }
      }
      for (const tabId of tabIdsToClose) {
        useAppStore.getState().closeUnifiedTab(tabId)
      }
      await refresh()
      toast.success(`'${deleteTarget.title}' deleted`)
      setDeleteTarget(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to delete '${deleteTarget.title}'.`)
    } finally {
      setDeleting(false)
    }
  }, [deleteTarget, deleting, projectId, refresh, worktreeId])

  const copyNotePath = useCallback(async (note: NoteSummary): Promise<void> => {
    await navigator.clipboard.writeText(note.relativePath)
    toast.success('Note path copied')
  }, [])

  if (!projectId || !worktreeId) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
        Open a project worktree to use notes.
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-foreground">Project Notes</div>
          <div className="line-clamp-2 text-[11px] leading-4 text-muted-foreground">
            Shared across all workspaces for {repo?.displayName ?? 'this repo'}
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Refresh notes"
          onClick={() => void refresh()}
        >
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="New project notes tab"
          onClick={openNotes}
        >
          <Plus className="size-3.5" />
        </Button>
      </div>

      {error ? (
        <div className="border-b border-border px-3 py-2 text-xs text-destructive">{error}</div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {notes.length === 0 ? (
          <div className="px-3 py-4">
            <div className="text-xs font-medium text-foreground">No project notes yet</div>
            <div className="mt-1 text-[11px] leading-4 text-muted-foreground">
              Create one to keep repo context available across every workspace.
            </div>
          </div>
        ) : (
          notes.map((note) => (
            <ContextMenu key={note.id}>
              <ContextMenuTrigger asChild>
                <div
                  role="button"
                  tabIndex={0}
                  className="mx-1.5 flex w-[calc(100%-0.75rem)] items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-accent/45"
                  onClick={() => {
                    if (renamingNoteId !== note.id) {
                      void selectNote(note.id)
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') {
                      return
                    }
                    event.preventDefault()
                    if (renamingNoteId !== note.id) {
                      void selectNote(note.id)
                    }
                  }}
                >
                  <FileText className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    {renamingNoteId === note.id ? (
                      <Input
                        autoFocus
                        value={renameValue}
                        className="h-6 px-2 text-xs"
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => setRenameValue(event.target.value)}
                        onFocus={(event) => event.currentTarget.select()}
                        onBlur={() => void commitRename(note)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            void commitRename(note)
                          } else if (event.key === 'Escape') {
                            event.preventDefault()
                            cancelRename()
                          }
                        }}
                      />
                    ) : (
                      <span className="block truncate text-xs font-medium text-foreground">
                        {note.title}
                      </span>
                    )}
                    <span className="mt-0.5 line-clamp-2 block text-[11px] leading-4 text-muted-foreground">
                      {note.preview || note.relativePath}
                    </span>
                  </span>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => void selectNote(note.id)}>
                  <FileText className="size-3.5" />
                  Open
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => startRename(note)}>
                  <Pencil className="size-3.5" />
                  Rename
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => void copyNotePath(note)}>
                  <Copy className="size-3.5" />
                  Copy Path
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem variant="destructive" onSelect={() => setDeleteTarget(note)}>
                  <Trash2 className="size-3.5" />
                  Delete
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ))
        )}
      </div>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (open) {
            return
          }
          setDeleteTarget(null)
          setDeleting(false)
        }}
      >
        <DialogContent
          className="max-w-md"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            deleteConfirmButtonRef.current?.focus()
          }}
        >
          <DialogHeader>
            <DialogTitle className="text-sm">Delete Project Note</DialogTitle>
            <DialogDescription className="text-xs">
              Delete{' '}
              <span className="break-all font-medium text-foreground">{deleteTarget?.title}</span>?
              This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {deleteTarget ? (
            <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
              <div className="break-all font-medium text-foreground">{deleteTarget.title}</div>
              <div className="mt-1 break-all text-muted-foreground">
                {deleteTarget.relativePath}
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={deleting}
              onClick={() => {
                setDeleteTarget(null)
                setDeleting(false)
              }}
            >
              Cancel
            </Button>
            <Button
              ref={deleteConfirmButtonRef}
              variant="destructive"
              disabled={deleting}
              onClick={() => void confirmDeleteNote()}
            >
              <Trash2 className="size-4" />
              {deleting ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
