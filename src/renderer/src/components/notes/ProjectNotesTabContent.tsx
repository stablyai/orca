/* eslint-disable max-lines -- Why: project notes keep picker, save-as, and
   rich/source/preview markdown modes together so unsaved note creation and
   active-note switching cannot drift across separate surfaces. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Copy, FileText, MoreHorizontal, Plus, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import RichMarkdownEditor from '@/components/editor/RichMarkdownEditor'
import MarkdownPreview from '@/components/editor/MarkdownPreview'
import EditorViewToggle from '@/components/editor/EditorViewToggle'
import { useAppStore } from '@/store'
import { useRepoById, useWorktreeById } from '@/store/selectors'
import { NOTES_ACTIVE_CHANGED_EVENT } from '@/lib/notes-events'
import {
  getProjectNotesEntityId,
  notifyProjectNotesSelectionChanged
} from '@/lib/open-project-notes-tab'
import {
  ORCA_PROJECT_NOTES_REQUEST_CLOSE_EVENT,
  type ProjectNotesCloseRequestDetail
} from '@/lib/project-notes-close-request'
import { toast } from 'sonner'
import type { MarkdownDocument } from '../../../../shared/types'
import type { NoteRecord, NoteSummary, NotesPanelOpenState } from '../../../../shared/notes-types'
import type { MarkdownViewMode } from '@/store/slices/editor'

const SAVE_DEBOUNCE_MS = 700

type Draft = {
  id: string | null
  filePath: string | null
  relativePath: string | null
  title: string
  bodyMarkdown: string
  revision: number | null
}

function emptyDraft(): Draft {
  return {
    id: null,
    filePath: null,
    relativePath: null,
    title: 'Untitled note',
    bodyMarkdown: '',
    revision: null
  }
}

export default function ProjectNotesTabContent({
  worktreeId,
  tabId,
  noteId = null,
  forceNew = false,
  onDirtyChange
}: {
  worktreeId: string
  tabId: string
  noteId?: string | null
  forceNew?: boolean
  onDirtyChange?: (dirty: boolean) => void
}): React.JSX.Element {
  const worktree = useWorktreeById(worktreeId)
  const repo = useRepoById(worktree?.repoId ?? null)
  const projectId = repo?.id ?? worktree?.repoId ?? null

  const [panelState, setPanelState] = useState<NotesPanelOpenState>({ state: 'noProject' })
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [draft, setDraft] = useState<Draft>(() => emptyDraft())
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<MarkdownViewMode>('rich')
  const [saveAsOpen, setSaveAsOpen] = useState(false)
  const [closePromptOpen, setClosePromptOpen] = useState(false)
  const [saveAsTitle, setSaveAsTitle] = useState('Untitled note')
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(noteId)
  const saveAsInputRef = useRef<HTMLInputElement>(null)
  const pendingCreateBodyRef = useRef<string | null>(null)
  const pendingCloseRef = useRef<(() => void) | null>(null)

  const canSave = projectId !== null && (draft.id === null || draft.title.trim().length > 0)

  const refreshNotes = useCallback(async (): Promise<void> => {
    if (!projectId) {
      setNotes([])
      return
    }
    const result = await window.api.notes.list({ projectId, worktreeId, limit: 100 })
    setNotes(result.notes)
  }, [projectId, worktreeId])

  const loadPanelState = useCallback(async (): Promise<void> => {
    try {
      setError(null)
      if (selectedNoteId && projectId) {
        const result = await window.api.notes.show({ projectId, worktreeId, note: selectedNoteId })
        setPanelState({ state: 'active', projectId, worktreeId, note: result.note })
        setDraft({
          id: result.note.id,
          filePath: result.note.filePath,
          relativePath: result.note.relativePath,
          title: result.note.title,
          bodyMarkdown: result.note.bodyMarkdown,
          revision: result.note.revision
        })
        setDirty(false)
        const state = useAppStore.getState()
        state.setTabLabel(tabId, result.note.title)
        state.setTabEntityId(tabId, getProjectNotesEntityId(projectId, result.note.id))
        await refreshNotes()
        return
      }
      if (forceNew && projectId) {
        setPanelState({ state: 'emptyDraft', projectId, worktreeId })
        setDraft(emptyDraft())
        setDirty(false)
        useAppStore.getState().setTabLabel(tabId, 'Project Notes')
        await refreshNotes()
        return
      }
      const next = await window.api.notes.panelState({ projectId, worktreeId })
      setPanelState(next)
      if (next.state === 'active') {
        setDraft({
          id: next.note.id,
          filePath: next.note.filePath,
          relativePath: next.note.relativePath,
          title: next.note.title,
          bodyMarkdown: next.note.bodyMarkdown,
          revision: next.note.revision
        })
        const state = useAppStore.getState()
        state.setTabLabel(tabId, next.note.title)
        state.setTabEntityId(tabId, getProjectNotesEntityId(next.projectId, next.note.id))
        setDirty(false)
      } else {
        setDraft(emptyDraft())
        useAppStore
          .getState()
          .setTabEntityId(tabId, getProjectNotesEntityId(projectId ?? worktreeId))
        setDirty(false)
      }
      if (next.state === 'pickerRequired') {
        setNotes(next.notes)
      } else {
        await refreshNotes()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [forceNew, projectId, refreshNotes, selectedNoteId, tabId, worktreeId])

  useEffect(() => {
    void loadPanelState()
  }, [loadPanelState])

  useEffect(() => {
    setSelectedNoteId(noteId)
  }, [noteId])

  useEffect(() => {
    useAppStore.getState().setTabDirty(tabId, dirty)
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange, tabId])

  useEffect(() => {
    const listener = (): void => {
      if (dirty) {
        return
      }
      void loadPanelState()
    }
    window.addEventListener(NOTES_ACTIVE_CHANGED_EVENT, listener)
    return () => window.removeEventListener(NOTES_ACTIVE_CHANGED_EVENT, listener)
  }, [dirty, loadPanelState])

  useEffect(() => {
    const listener = (event: Event): void => {
      const detail = (event as CustomEvent<ProjectNotesCloseRequestDetail>).detail
      if (!detail || detail.tabId !== tabId) {
        return
      }
      detail.claim()
      if (!dirty) {
        detail.close()
        return
      }
      pendingCloseRef.current = detail.close
      setClosePromptOpen(true)
    }
    window.addEventListener(ORCA_PROJECT_NOTES_REQUEST_CLOSE_EVENT, listener)
    return () => window.removeEventListener(ORCA_PROJECT_NOTES_REQUEST_CLOSE_EVENT, listener)
  }, [dirty, tabId])

  const selectNote = useCallback(
    async (noteId: string): Promise<void> => {
      if (!projectId) {
        return
      }
      const result = await window.api.notes.show({ projectId, worktreeId, note: noteId })
      await window.api.notes.link({ projectId, worktreeId, note: noteId, kind: 'active' })
      setSelectedNoteId(noteId)
      setDraft({
        id: result.note.id,
        filePath: result.note.filePath,
        relativePath: result.note.relativePath,
        title: result.note.title,
        bodyMarkdown: result.note.bodyMarkdown,
        revision: result.note.revision
      })
      setPanelState({ state: 'active', projectId, worktreeId, note: result.note })
      const state = useAppStore.getState()
      state.setTabLabel(tabId, result.note.title)
      state.setTabEntityId(tabId, getProjectNotesEntityId(projectId, result.note.id))
      setDirty(false)
      await refreshNotes()
    },
    [projectId, refreshNotes, tabId, worktreeId]
  )

  const saveDraft = useCallback(
    async (bodyOverride?: string): Promise<NoteRecord | null> => {
      if (!canSave || !projectId) {
        return null
      }
      const bodyMarkdown = bodyOverride ?? draft.bodyMarkdown
      if (!draft.id) {
        // Why: project notes are markdown files. Match untitled Markdown tabs
        // by asking for the user-facing name before creating the file instead
        // of silently persisting "Untitled note" from autosave.
        pendingCreateBodyRef.current = bodyMarkdown
        setSaveAsTitle(draft.title.trim() || 'Untitled note')
        setSaveAsOpen(true)
        return null
      }
      setSaving(true)
      try {
        const result = await window.api.notes.save({
          projectId,
          worktreeId,
          note: draft.id,
          title: draft.title,
          bodyMarkdown,
          revision: draft.revision ?? undefined,
          makeActive: true
        })
        setDraft({
          id: result.note.id,
          filePath: result.note.filePath,
          relativePath: result.note.relativePath,
          title: result.note.title,
          bodyMarkdown: result.note.bodyMarkdown,
          revision: result.note.revision
        })
        setPanelState({ state: 'active', projectId, worktreeId, note: result.note })
        setSelectedNoteId(result.note.id)
        const state = useAppStore.getState()
        state.setTabLabel(tabId, result.note.title)
        state.setTabEntityId(tabId, getProjectNotesEntityId(projectId, result.note.id))
        setDirty(false)
        await refreshNotes()
        notifyProjectNotesSelectionChanged()
        return result.note
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        return null
      } finally {
        setSaving(false)
      }
    },
    [canSave, draft, projectId, refreshNotes, tabId, worktreeId]
  )

  useEffect(() => {
    if (!dirty || !canSave || !draft.id) {
      return
    }
    const timer = window.setTimeout(() => {
      void saveDraft()
    }, SAVE_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [canSave, dirty, draft.id, saveDraft])

  const createNewDraft = useCallback(() => {
    setSelectedNoteId(null)
    setDraft(emptyDraft())
    const state = useAppStore.getState()
    state.setTabLabel(tabId, 'Project Notes')
    state.setTabEntityId(tabId, getProjectNotesEntityId(projectId ?? worktreeId))
    setPanelState(
      projectId ? { state: 'emptyDraft', projectId, worktreeId } : { state: 'noProject' }
    )
    setDirty(false)
  }, [projectId, tabId, worktreeId])

  const markdownDocuments = useMemo<MarkdownDocument[]>(
    () =>
      notes.map((note) => ({
        filePath: note.filePath,
        relativePath: note.relativePath,
        basename: note.relativePath.split('/').pop() ?? note.title,
        name: note.title
      })),
    [notes]
  )

  const editorFilePath =
    draft.filePath ?? `orca://project-notes/${projectId ?? 'project'}/untitled.md`
  const editorPathLabel = draft.filePath
    ? (draft.relativePath ?? draft.title)
    : `notes/${draft.title.trim() || 'untitled'}.md`

  useEffect(() => {
    if (error) {
      toast.error(error)
    }
  }, [error])

  useEffect(() => {
    if (!saveAsOpen) {
      return
    }
    requestAnimationFrame(() => saveAsInputRef.current?.select())
  }, [saveAsOpen])

  const confirmCreateNote = useCallback(async (): Promise<void> => {
    if (!projectId) {
      return
    }
    const title = saveAsTitle.trim().replace(/\.md$/i, '')
    if (!title) {
      setError('Name cannot be empty')
      return
    }
    setSaving(true)
    try {
      const result = await window.api.notes.create({
        projectId,
        worktreeId,
        title,
        bodyMarkdown: pendingCreateBodyRef.current ?? draft.bodyMarkdown,
        makeActive: true
      })
      setDraft({
        id: result.note.id,
        filePath: result.note.filePath,
        relativePath: result.note.relativePath,
        title: result.note.title,
        bodyMarkdown: result.note.bodyMarkdown,
        revision: result.note.revision
      })
      setPanelState({ state: 'active', projectId, worktreeId, note: result.note })
      setSelectedNoteId(result.note.id)
      const state = useAppStore.getState()
      state.setTabLabel(tabId, result.note.title)
      state.setTabEntityId(tabId, getProjectNotesEntityId(projectId, result.note.id))
      setDirty(false)
      setSaveAsOpen(false)
      pendingCreateBodyRef.current = null
      await refreshNotes()
      notifyProjectNotesSelectionChanged()
      const pendingClose = pendingCloseRef.current
      if (pendingClose) {
        pendingCloseRef.current = null
        pendingClose()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [draft.bodyMarkdown, projectId, refreshNotes, saveAsTitle, tabId, worktreeId])

  const handleClosePromptSave = useCallback(async (): Promise<void> => {
    setClosePromptOpen(false)
    const saved = await saveDraft()
    if (!saved) {
      if (draft.id) {
        setClosePromptOpen(true)
      }
      return
    }
    const pendingClose = pendingCloseRef.current
    pendingCloseRef.current = null
    pendingClose?.()
  }, [draft.id, saveDraft])

  const handleClosePromptDiscard = useCallback(() => {
    setClosePromptOpen(false)
    setDirty(false)
    const pendingClose = pendingCloseRef.current
    pendingCloseRef.current = null
    pendingClose?.()
  }, [])

  const handleClosePromptCancel = useCallback(() => {
    setClosePromptOpen(false)
    pendingCloseRef.current = null
  }, [])

  const handleSaveAsCancel = useCallback(() => {
    setSaveAsOpen(false)
    pendingCreateBodyRef.current = null
    pendingCloseRef.current = null
  }, [])

  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="editor-header">
        <div className="editor-header-text">
          <div className="editor-header-path-row">
            <button
              type="button"
              className="editor-header-path"
              title={editorFilePath}
              onClick={() => {
                void window.api.ui.writeClipboardText(editorFilePath)
              }}
            >
              {editorPathLabel}
            </button>
          </div>
        </div>
        <EditorViewToggle
          value={viewMode}
          modes={['source', 'rich', 'preview']}
          onChange={(next) => setViewMode(next as MarkdownViewMode)}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground hover:text-foreground"
              aria-label="More actions"
              title="More actions"
            >
              <MoreHorizontal size={14} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel>Current note</DropdownMenuLabel>
            <div className="px-2 pb-2">
              <Input
                value={draft.title}
                disabled={panelState.state === 'noProject'}
                onChange={(event) => {
                  setDraft((current) => ({ ...current, title: event.target.value }))
                  setDirty(true)
                }}
                className="h-8 text-xs"
                placeholder="Note title"
              />
            </div>
            <DropdownMenuItem onSelect={createNewDraft}>
              <Plus className="size-3.5" />
              New note
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                void window.api.ui.writeClipboardText(draft.bodyMarkdown)
              }}
            >
              <Copy className="size-3.5" />
              Copy Markdown
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!canSave || saving} onSelect={() => void saveDraft()}>
              <Save className="size-3.5" />
              Save now
            </DropdownMenuItem>
            {notes.length > 0 ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Switch note</DropdownMenuLabel>
                {notes.map((note) => (
                  <DropdownMenuItem key={note.id} onSelect={() => void selectNote(note.id)}>
                    <FileText className="size-3.5" />
                    <span className="truncate">{note.title}</span>
                  </DropdownMenuItem>
                ))}
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {panelState.state === 'noProject' ? (
          <div className="flex h-full items-center justify-center px-4 text-sm text-muted-foreground">
            Open a project worktree to use notes.
          </div>
        ) : panelState.state === 'pickerRequired' ? (
          <div className="flex h-full flex-col overflow-y-auto px-8 py-6">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">Project Notes</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Choose a saved note or start a new one.
                </div>
              </div>
              <Button type="button" size="sm" variant="outline" onClick={createNewDraft}>
                <Plus className="size-3.5" />
                New note
              </Button>
            </div>
            <div className="space-y-1">
              {notes.map((note) => (
                <button
                  key={note.id}
                  type="button"
                  className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left hover:bg-accent/45"
                  onClick={() => void selectNote(note.id)}
                >
                  <FileText className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {note.title}
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-xs leading-5 text-muted-foreground">
                      {note.preview || note.relativePath}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : viewMode === 'source' ? (
          <textarea
            className="h-full w-full resize-none bg-background px-8 py-6 font-mono text-[13px] leading-6 text-foreground outline-none scrollbar-editor"
            value={draft.bodyMarkdown}
            spellCheck={false}
            onChange={(event) => {
              setDraft((current) => ({ ...current, bodyMarkdown: event.target.value }))
              setDirty(true)
            }}
            onKeyDown={(event) => {
              const isMac = navigator.userAgent.includes('Mac')
              const saveShortcut = isMac ? event.metaKey : event.ctrlKey
              if (saveShortcut && event.key.toLowerCase() === 's') {
                event.preventDefault()
                void saveDraft()
              }
            }}
          />
        ) : viewMode === 'preview' ? (
          <MarkdownPreview
            content={draft.bodyMarkdown}
            filePath={editorFilePath}
            scrollCacheKey={`notes:${draft.id ?? 'new'}:preview`}
            markdownDocuments={markdownDocuments}
            onOpenDocument={(document) => {
              const note = notes.find((candidate) => candidate.filePath === document.filePath)
              if (note) {
                void selectNote(note.id)
              }
            }}
          />
        ) : (
          <RichMarkdownEditor
            fileId={draft.id ?? 'new-note'}
            content={draft.bodyMarkdown}
            filePath={editorFilePath}
            worktreeId={worktreeId}
            scrollCacheKey={`notes:${draft.id ?? 'new'}`}
            onContentChange={(content) => {
              setDraft((current) => ({ ...current, bodyMarkdown: content }))
              setDirty(true)
            }}
            onDirtyStateHint={(nextDirty) => {
              if (nextDirty) {
                setDirty(true)
              }
            }}
            onSave={(content) => {
              setDraft((current) => ({ ...current, bodyMarkdown: content }))
              setDirty(true)
              void saveDraft(content)
            }}
            markdownDocuments={markdownDocuments}
          />
        )}
      </div>
      <Dialog
        open={saveAsOpen}
        onOpenChange={(isOpen) => {
          if (isOpen) {
            return
          }
          handleSaveAsCancel()
        }}
      >
        <DialogContent showCloseButton={false} className="max-w-[340px]">
          <DialogHeader>
            <DialogTitle className="text-sm">Save project note</DialogTitle>
            <DialogDescription className="text-xs">
              Name this markdown note before saving it in Orca project notes.
            </DialogDescription>
          </DialogHeader>
          <div>
            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">Name</label>
            <div className="flex items-center gap-1.5">
              <Input
                ref={saveAsInputRef}
                value={saveAsTitle}
                onChange={(event) => setSaveAsTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void confirmCreateNote()
                  }
                }}
                className="h-8 text-sm"
                placeholder="note name"
              />
              <span className="shrink-0 text-xs text-muted-foreground">.md</span>
            </div>
          </div>
          <DialogFooter className="mt-1">
            <Button variant="outline" size="sm" onClick={handleSaveAsCancel}>
              Cancel
            </Button>
            <Button size="sm" disabled={saving} onClick={() => void confirmCreateNote()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={closePromptOpen}
        onOpenChange={(isOpen) => {
          if (!isOpen) {
            handleClosePromptCancel()
          }
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">Unsaved Changes</DialogTitle>
            <DialogDescription className="text-xs">
              &quot;{draft.title.trim() || 'Project Notes'}&quot; has unsaved changes. Do you want
              to save before closing?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" size="sm" onClick={handleClosePromptCancel}>
              Cancel
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={handleClosePromptDiscard}>
              Don&apos;t Save
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={saving}
              onClick={() => void handleClosePromptSave()}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
