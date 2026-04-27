/* eslint-disable max-lines -- Why: EditorPanel still owns the visible editor
save/load/render lifecycle for many modes (edit, diff, conflict review), and
keeping that UI state together is easier to reason about than scattering it
across multiple components. Autosave now lives in a smaller headless controller
so hidden editor UI no longer participates in shutdown. */
import React, { useCallback, useEffect, useRef, useState, Suspense } from 'react'
import * as monaco from 'monaco-editor'
import { Columns2, Copy, Eye, ExternalLink, FileText, MoreHorizontal, Rows2 } from 'lucide-react'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { getConnectionId } from '@/lib/connection-context'
import { detectLanguage } from '@/lib/language-detect'
import { canPreviewLanguage, openFilePreviewToSide } from '@/lib/file-preview'
import { getEditorHeaderCopyState, getEditorHeaderOpenFileState } from './editor-header'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from '../tab-bar/SortableTab'
import type { MarkdownViewMode, OpenFile } from '@/store/slices/editor'
import MarkdownViewToggle from './MarkdownViewToggle'
import { EditorContent } from './EditorContent'
import { scrollTopCache, cursorPositionCache, diffViewStateCache } from '@/lib/scroll-cache'
import type { GitDiffResult } from '../../../../shared/types'
import {
  getOpenFilesForExternalFileChange,
  ORCA_EDITOR_FILE_SAVED_EVENT,
  ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT,
  requestEditorFileSave,
  requestEditorSaveQuiesce,
  ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT,
  type EditorFileSavedDetail,
  type EditorPathMutationTarget
} from './editor-autosave'
import { UntitledFileRenameDialog } from './UntitledFileRenameDialog'
import { exportActiveMarkdownToPdf } from './export-active-markdown'
import {
  canOpenMarkdownPreview,
  getDefaultMarkdownViewMode,
  getMarkdownPreviewShortcutLabel,
  getMarkdownViewModes,
  isMarkdownPreviewShortcut
} from './markdown-preview-controls'

const isMac = navigator.userAgent.includes('Mac')
const isLinux = navigator.userAgent.includes('Linux')

/** Platform-appropriate label: macOS → Finder, Windows → File Explorer, Linux → Files */
const revealLabel = isMac
  ? 'Reveal in Finder'
  : isLinux
    ? 'Open Containing Folder'
    : 'Reveal in File Explorer'
const markdownPreviewShortcutLabel = getMarkdownPreviewShortcutLabel(isMac)

type FileContent = {
  content: string
  isBinary: boolean
  isImage?: boolean
  mimeType?: string
}

type DiffContent = GitDiffResult

// Why: split-pane layouts mount one EditorPanel per pane, and each panel
// attaches its own listener to `ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT`.
// Without coordination, a single external write fans out into N concurrent
// `readFile` IPCs for the same path plus N independent `setContent`
// transactions on the downstream rich editors — a meaningful contributor to
// the black-window wedge reported in issue #826. Sharing a module-level
// in-flight promise per (connectionId, filePath) collapses those N reads
// into one round-trip while still letting each panel update its own local
// state with the result.
const inFlightFileReads = new Map<string, Promise<FileContent>>()
const inFlightDiffReads = new Map<string, Promise<DiffContent>>()

// Why: the "File → Export as PDF..." menu IPC fans out to every EditorPanel
// instance, and split-pane layouts mount N panels concurrently. Without a
// guard, a single menu click would spawn N concurrent exports — each racing
// its own save dialog, toast, and printToPDF — producing duplicate output
// files and confusing UX. This module-level ref-counted singleton installs
// exactly one IPC subscription the first time any panel mounts, and tears
// it down only when the last panel unmounts. A simple "first mounter wins"
// counter would go dead if the first-mounting panel unmounted while others
// were still mounted — survivors never re-subscribed and the menu silently
// stopped working. The singleton pattern avoids that handoff bug entirely.
let exportPdfListenerOwners = 0
let exportPdfListenerUnsubscribe: (() => void) | null = null
function acquireExportPdfListener(): () => void {
  exportPdfListenerOwners += 1
  if (exportPdfListenerOwners === 1) {
    exportPdfListenerUnsubscribe = window.api.ui.onExportPdfRequested(() => {
      void exportActiveMarkdownToPdf()
    })
  }
  return () => {
    exportPdfListenerOwners -= 1
    if (exportPdfListenerOwners === 0 && exportPdfListenerUnsubscribe) {
      exportPdfListenerUnsubscribe()
      exportPdfListenerUnsubscribe = null
    }
  }
}

function inFlightReadKey(connectionId: string | undefined, filePath: string): string {
  return `${connectionId ?? ''}::${filePath}`
}

function inFlightDiffKey(file: OpenFile, connectionId: string | undefined): string {
  // Why: diff content depends on the file path AND which diff source is
  // being rendered (unstaged/staged/branch). Branch diffs further depend
  // on the base+head oids so switching compare points doesn't alias, and
  // on branchOldPath so rename-detected diffs don't alias with the same
  // post-rename path viewed without rename metadata.
  const branch =
    file.diffSource === 'branch' && file.branchCompare
      ? `${file.branchCompare.baseOid ?? ''}..${file.branchCompare.headOid ?? ''}::${file.branchOldPath ?? ''}`
      : ''
  return `${connectionId ?? ''}::${file.diffSource ?? ''}::${file.filePath}::${branch}`
}

function EditorPanelInner({
  activeFileId: activeFileIdProp,
  activeViewStateId: activeViewStateIdProp
}: {
  activeFileId?: string | null
  activeViewStateId?: string | null
} = {}): React.JSX.Element | null {
  const openFiles = useAppStore((s) => s.openFiles)
  const globalActiveFileId = useAppStore((s) => s.activeFileId)
  const activeFileId = activeFileIdProp ?? globalActiveFileId
  const markFileDirty = useAppStore((s) => s.markFileDirty)
  const pendingEditorReveal = useAppStore((s) => s.pendingEditorReveal)
  const gitStatusByWorktree = useAppStore((s) => s.gitStatusByWorktree)
  const gitBranchChangesByWorktree = useAppStore((s) => s.gitBranchChangesByWorktree)
  const markdownViewMode = useAppStore((s) => s.markdownViewMode)
  const setMarkdownViewMode = useAppStore((s) => s.setMarkdownViewMode)
  const openFile = useAppStore((s) => s.openFile)
  const openMarkdownPreview = useAppStore((s) => s.openMarkdownPreview)
  const closeFile = useAppStore((s) => s.closeFile)
  const clearUntitled = useAppStore((s) => s.clearUntitled)
  const editorDrafts = useAppStore((s) => s.editorDrafts)
  const setEditorDraft = useAppStore((s) => s.setEditorDraft)
  const settings = useAppStore((s) => s.settings)

  const activeFile = openFiles.find((f) => f.id === activeFileId) ?? null
  const activeFilePath = activeFile?.filePath ?? null
  const activeFileRelativePath = activeFile?.relativePath ?? null
  const activeFileWorktreeId = activeFile?.worktreeId ?? null
  const activeFileMode = activeFile?.mode ?? null
  const activeFileDiffSource = activeFile?.diffSource
  const activeViewStateId = activeViewStateIdProp ?? activeFileId

  const [fileContents, setFileContents] = useState<Record<string, FileContent>>({})
  const [diffContents, setDiffContents] = useState<Record<string, DiffContent>>({})
  const [copiedPathToast, setCopiedPathToast] = useState<{ fileId: string; token: number } | null>(
    null
  )
  const [renameDialogFileId, setRenameDialogFileId] = useState<string | null>(null)
  const renameDialogFile = renameDialogFileId
    ? openFiles.find((f) => f.id === renameDialogFileId)
    : null
  const [sideBySide, setSideBySide] = useState(settings?.diffDefaultView === 'side-by-side')
  const [prevDiffView, setPrevDiffView] = useState(settings?.diffDefaultView)
  const [pathMenuOpen, setPathMenuOpen] = useState(false)
  const [pathMenuPoint, setPathMenuPoint] = useState({ x: 0, y: 0 })
  const panelRef = useRef<HTMLDivElement>(null)

  const deleteCacheEntriesByPrefix = useCallback(<T,>(cache: Map<string, T>, prefix: string) => {
    for (const key of cache.keys()) {
      if (key.startsWith(prefix)) {
        cache.delete(key)
      }
    }
  }, [])

  // Why: When the user changes their global diff-view preference in Settings,
  // sync the local toggle to match during render (avoids flash of stale diff mode).
  if (settings?.diffDefaultView !== prevDiffView) {
    setPrevDiffView(settings?.diffDefaultView)
    if (settings?.diffDefaultView !== undefined) {
      setSideBySide(settings.diffDefaultView === 'side-by-side')
    }
  }

  const openFilesRef = useRef(openFiles)
  openFilesRef.current = openFiles

  useEffect(() => {
    const closeMenu = (): void => setPathMenuOpen(false)
    window.addEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
    return () => window.removeEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
  }, [])

  // Why: the system "File → Export as PDF..." menu item sends a one-way IPC
  // event that reaches whichever renderer has focus. The EditorPanel is the
  // natural owner of the active markdown surface, so the listener lives here
  // and delegates to the shared export helper. Both entry points (menu and
  // overflow button) funnel through exportActiveMarkdownToPdf so toasts and
  // no-op gating stay consistent.
  // Why (guard): split-pane layouts mount multiple EditorPanelInner instances.
  // We ref-count via `acquireExportPdfListener` so exactly one IPC subscription
  // exists regardless of how many panels are mounted — and it survives panel
  // churn as long as at least one panel is still mounted.
  useEffect(() => acquireExportPdfListener(), [])

  // Why: keepCurrentModel / keepCurrent*Model retain Monaco models after unmount
  // so undo history survives tab switches. When a tab is *closed*, the user has
  // signalled they're done with the file — dispose the models to reclaim memory
  // and delete cache entries so a reopened file starts fresh.
  const prevOpenFilesRef = useRef<Map<string, OpenFile>>(new Map())

  useEffect(() => {
    const currentFilesById = new Map(openFiles.map((f) => [f.id, f]))
    for (const [prevId, prevFile] of prevOpenFilesRef.current) {
      if (!currentFilesById.has(prevId)) {
        // Dispose only the kept-alive Monaco state that this tab mode owns.
        // Why: edit and diff tabs use different retained-model keys, while the
        // conflict-review surface does not create kept Monaco models today. An
        // explicit switch makes that ownership boundary visible so future mode
        // additions do not silently fall through without considering cleanup.
        switch (prevFile.mode) {
          case 'edit':
            // Why: the edit model URI is constructed via monaco.Uri.parse(filePath)
            // to match what @monaco-editor/react creates internally when the `path`
            // prop is provided. This convention is version-dependent.
            monaco.editor.getModel(monaco.Uri.parse(prevFile.filePath))?.dispose()
            scrollTopCache.delete(prevFile.filePath)
            deleteCacheEntriesByPrefix(scrollTopCache, `${prevFile.filePath}::`)
            // Why: markdown edit tabs keep separate source/rich scroll caches,
            // and older sessions may still have the legacy in-place preview key.
            // Clear all of them so reopened files never inherit stale viewport
            // state from a prior tab incarnation.
            scrollTopCache.delete(`${prevFile.filePath}:rich`)
            scrollTopCache.delete(`${prevFile.filePath}:preview`)
            // Why: mermaid files use a mode-scoped cache key just like markdown.
            // Without this, a reopened .mmd file would restore a stale scroll
            // position from the previous session even if the content changed.
            scrollTopCache.delete(`${prevFile.filePath}:mermaid-diagram`)
            cursorPositionCache.delete(prevFile.filePath)
            deleteCacheEntriesByPrefix(cursorPositionCache, `${prevFile.filePath}::`)
            break
          case 'markdown-preview':
            // Why: preview tabs have no retained Monaco models, but they do
            // own pane-scoped preview scroll cache entries that should be
            // dropped on close so reopening the preview starts fresh.
            scrollTopCache.delete(`${prevFile.id}:preview`)
            deleteCacheEntriesByPrefix(scrollTopCache, `${prevFile.id}::`)
            break
          case 'diff':
            // Why: kept diff models are keyed by tab id, not file path, because the
            // same file can appear in multiple diff tabs with different contents.
            monaco.editor.getModel(monaco.Uri.parse(`diff:original:${prevId}`))?.dispose()
            monaco.editor.getModel(monaco.Uri.parse(`diff:modified:${prevId}`))?.dispose()
            diffViewStateCache.delete(prevId)
            deleteCacheEntriesByPrefix(diffViewStateCache, `${prevId}::`)
            // Why: single-file markdown diffs now have a rendered preview mode
            // whose scroll position is keyed off the diff tab identity rather
            // than a Monaco view-state cache entry. Clear those mode-scoped
            // keys alongside the diff models so reopened diff tabs start fresh.
            scrollTopCache.delete(`${prevId}:preview`)
            deleteCacheEntriesByPrefix(scrollTopCache, `${prevId}::`)
            break
          case 'conflict-review':
            break
        }
      }
    }
    prevOpenFilesRef.current = currentFilesById
  }, [deleteCacheEntriesByPrefix, openFiles])

  // Load file content when active file changes
  useEffect(() => {
    if (!activeFile) {
      return
    }
    if (activeFile.mode === 'conflict-review') {
      return
    }
    if (activeFile.mode === 'edit' || activeFile.mode === 'markdown-preview') {
      if (activeFile.conflict?.kind === 'conflict-placeholder') {
        return
      }
      if (fileContents[activeFile.id]) {
        return
      }
      void loadFileContent(activeFile.filePath, activeFile.id, activeFile.worktreeId)
    } else if (
      activeFile.mode === 'diff' &&
      activeFile.diffSource !== undefined &&
      activeFile.diffSource !== 'combined-uncommitted' &&
      activeFile.diffSource !== 'combined-branch'
    ) {
      if (diffContents[activeFile.id]) {
        return
      }
      void loadDiffContent(activeFile)
    }
  }, [activeFile?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!copiedPathToast) {
      return
    }
    const timeout = window.setTimeout(() => setCopiedPathToast(null), 1500)
    return () => window.clearTimeout(timeout)
  }, [copiedPathToast])

  const loadFileContent = useCallback(
    async (filePath: string, id: string, worktreeId?: string): Promise<void> => {
      try {
        const connectionId = getConnectionId(worktreeId ?? null) ?? undefined
        const key = inFlightReadKey(connectionId, filePath)
        // Why: share the IPC round-trip across split-pane EditorPanels viewing
        // the same file. The first caller starts the read and registers the
        // promise; concurrent callers (triggered by the same external-change
        // event) await it instead of firing duplicate reads and duplicate
        // downstream setContent transactions.
        let pending = inFlightFileReads.get(key)
        if (!pending) {
          pending = window.api.fs.readFile({ filePath, connectionId }) as Promise<FileContent>
          inFlightFileReads.set(key, pending)
          // Why: limit deduplication to synchronous callers (like N split panes
          // responding to the exact same event loop dispatch). Caching the promise
          // across time (e.g. until the IPC returns) means a new change event that
          // fires while the read is in-flight would receive stale content.
          queueMicrotask(() => {
            if (inFlightFileReads.get(key) === pending) {
              inFlightFileReads.delete(key)
            }
          })
        }
        const result = await pending
        setFileContents((prev) => ({ ...prev, [id]: result }))
      } catch (err) {
        setFileContents((prev) => ({
          ...prev,
          [id]: { content: `Error loading file: ${err}`, isBinary: false }
        }))
      }
    },
    []
  )

  const loadDiffContent = useCallback(async (file: OpenFile | null): Promise<void> => {
    if (!file) {
      return
    }
    try {
      // Extract worktree path from absolute file path and relative path
      const worktreePath = file.filePath.slice(
        0,
        file.filePath.length - file.relativePath.length - 1
      )
      const branchCompare =
        file.branchCompare?.baseOid && file.branchCompare.headOid && file.branchCompare.mergeBase
          ? file.branchCompare
          : null
      const connectionId = getConnectionId(file.worktreeId) ?? undefined
      const key = inFlightDiffKey(file, connectionId)
      // Why: same rationale as inFlightFileReads above — a single external
      // change fans out to every mounted EditorPanel, and two split panes
      // showing the same diff tab should share one git.diff IPC instead of
      // racing two identical calls through the same git repo lock.
      let pending = inFlightDiffReads.get(key)
      if (!pending) {
        pending = (
          file.diffSource === 'branch' && branchCompare
            ? window.api.git.branchDiff({
                worktreePath,
                compare: {
                  baseRef: branchCompare.baseRef,
                  baseOid: branchCompare.baseOid!,
                  headOid: branchCompare.headOid!,
                  mergeBase: branchCompare.mergeBase!
                },
                filePath: file.relativePath,
                oldPath: file.branchOldPath,
                connectionId
              })
            : window.api.git.diff({
                worktreePath,
                filePath: file.relativePath,
                staged: file.diffSource === 'staged',
                connectionId
              })
        ) as Promise<DiffContent>
        inFlightDiffReads.set(key, pending)
        queueMicrotask(() => {
          if (inFlightDiffReads.get(key) === pending) {
            inFlightDiffReads.delete(key)
          }
        })
      }
      const result = await pending
      setDiffContents((prev) => ({ ...prev, [file.id]: result }))
    } catch (err) {
      setDiffContents((prev) => ({
        ...prev,
        [file.id]: {
          kind: 'text',
          originalContent: '',
          modifiedContent: `Error loading diff: ${err}`,
          originalIsBinary: false,
          modifiedIsBinary: false
        }
      }))
    }
  }, [])

  const handleContentChange = useCallback(
    (content: string) => {
      if (!activeFile) {
        return
      }
      setEditorDraft(activeFile.id, content)
      // Why: TipTap's getMarkdown() always appends a trailing newline to the
      // serialized output. If the file on disk lacks that newline the naive
      // strict-equality check treats the file as dirty even though no user edit
      // occurred. Normalising trailing whitespace for markdown files mirrors the
      // same trimEnd() used in the round-trip checker (markdown-round-trip.ts).
      const isMarkdown = activeFile.language === 'markdown'
      const normalize = isMarkdown ? (s: string): string => s.trimEnd() : (s: string): string => s
      if (activeFile.mode === 'edit') {
        const saved = fileContents[activeFile.id]?.content ?? ''
        markFileDirty(activeFile.id, normalize(content) !== normalize(saved))
      } else {
        // Diff mode: compare against the original modified content from git
        const dc = diffContents[activeFile.id]
        const original = dc?.kind === 'text' ? dc.modifiedContent : ''
        markFileDirty(activeFile.id, normalize(content) !== normalize(original))
      }
    },
    [activeFile, diffContents, fileContents, markFileDirty, setEditorDraft]
  )

  const handleDirtyStateHint = useCallback(
    (dirty: boolean) => {
      if (!activeFile) {
        return
      }

      // Why: RichMarkdownEditor debounces markdown serialization to keep
      // typing responsive on large documents. The store still needs an
      // immediate dirty signal so close prompts and window-unload guards do
      // not miss edits made in the last debounce window.
      markFileDirty(activeFile.id, dirty)
    },
    [activeFile, markFileDirty]
  )

  const handleSave = useCallback(
    async (content: string) => {
      if (!activeFile) {
        return
      }
      const saveTargetFile =
        activeFile.mode === 'markdown-preview'
          ? (openFiles.find(
              (openFile) =>
                openFile.id === activeFile.markdownPreviewSourceFileId && openFile.mode === 'edit'
            ) ?? null)
          : activeFile
      if (!saveTargetFile) {
        return
      }
      // Why: for untitled files, Cmd+S should prompt for a name before
      // writing anything. Saving first would make Cancel misleading since
      // the write already happened. Show the dialog and let the confirm
      // handler do the save + rename atomically.
      if (saveTargetFile.isUntitled) {
        setRenameDialogFileId(saveTargetFile.id)
        return
      }
      try {
        await requestEditorFileSave({ fileId: saveTargetFile.id, fallbackContent: content })
      } catch {}
    },
    [activeFile, openFiles]
  )

  // Why: global Cmd+S (from Terminal.tsx) dispatches this event when
  // focus is outside the editor content area. Delegate to handleSave
  // so untitled files still show the rename dialog.
  useEffect(() => {
    const handler = (): void => {
      if (!activeFile) {
        return
      }
      const saveTargetFile =
        activeFile.mode === 'markdown-preview'
          ? (openFilesRef.current.find(
              (openFile) =>
                openFile.id === activeFile.markdownPreviewSourceFileId && openFile.mode === 'edit'
            ) ?? null)
          : activeFile
      if (!saveTargetFile) {
        return
      }
      // Why: a markdown preview tab is read-only but still fronts the same
      // underlying document. Cmd/Ctrl+S should save that source editor's draft
      // instead of no-oping just because the preview tab currently has focus.
      const state = useAppStore.getState()
      const draft = state.editorDrafts[saveTargetFile.id]
      if (!draft && !saveTargetFile.isUntitled && !saveTargetFile.isDirty) {
        return
      }
      const fallbackContent =
        draft ??
        (activeFile.mode === 'markdown-preview' ? fileContents[activeFile.id]?.content : '')
      void handleSave(fallbackContent ?? '')
    }
    window.addEventListener(ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT, handler)
    return () => window.removeEventListener(ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT, handler)
  }, [activeFile, fileContents, handleSave])

  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<EditorPathMutationTarget>).detail
      if (!detail) {
        return
      }

      const matchingFiles = getOpenFilesForExternalFileChange(openFilesRef.current, detail)
      if (matchingFiles.length === 0) {
        return
      }
      // Why: do NOT delete fileContents[file.id] here before the reload
      // completes. Dropping the entry renders EditorContent's "Loading..."
      // placeholder and unmounts MonacoEditor. On remount, @monaco-editor/react
      // skips its value-sync effect on the first render, and `keepCurrentModel`
      // retains the prior model — so the new content prop never reaches the
      // editor and the user sees the pre-external-edit text linger.
      // loadFileContent / loadDiffContent overwrite the entry atomically once
      // the fresh read returns, which is what Monaco's value-sync can observe.
      for (const file of matchingFiles) {
        if (file.mode === 'edit' || file.mode === 'markdown-preview') {
          void loadFileContent(file.filePath, file.id, file.worktreeId)
        } else if (
          file.mode === 'diff' &&
          file.diffSource !== 'combined-uncommitted' &&
          file.diffSource !== 'combined-branch'
        ) {
          void loadDiffContent(file)
        }
      }
    }

    window.addEventListener(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, handler as EventListener)
    return () =>
      window.removeEventListener(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, handler as EventListener)
  }, [loadDiffContent, loadFileContent])

  useEffect(() => {
    const openIds = new Set(openFiles.map((f) => f.id))
    setFileContents((prev) => {
      const next: Record<string, FileContent> = {}
      for (const [k, v] of Object.entries(prev)) {
        if (openIds.has(k)) {
          next[k] = v
        }
      }
      return next
    })
    setDiffContents((prev) => {
      const next: Record<string, DiffContent> = {}
      for (const [k, v] of Object.entries(prev)) {
        if (openIds.has(k)) {
          next[k] = v
        }
      }
      return next
    })
  }, [openFiles])

  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<EditorFileSavedDetail>).detail
      if (!detail) {
        return
      }

      const file = openFilesRef.current.find((openFile) => openFile.id === detail.fileId)
      if (!file) {
        return
      }

      if (file.mode === 'edit' || file.mode === 'markdown-preview') {
        setFileContents((prev) => ({
          ...prev,
          [file.id]: { content: detail.content, isBinary: false }
        }))
      }

      const previewTabs = openFilesRef.current.filter(
        (openFile) =>
          openFile.mode === 'markdown-preview' &&
          openFile.markdownPreviewSourceFileId === detail.fileId
      )
      if (previewTabs.length > 0) {
        setFileContents((prev) => {
          const next = { ...prev }
          for (const previewTab of previewTabs) {
            next[previewTab.id] = { content: detail.content, isBinary: false }
          }
          return next
        })
      }

      if (file.mode === 'edit' || file.mode === 'markdown-preview') {
        return
      }

      setDiffContents((prev) => {
        const existing = prev[file.id]
        if (!existing || existing.kind !== 'text') {
          return prev
        }
        return {
          ...prev,
          [file.id]: { ...existing, modifiedContent: detail.content }
        }
      })
    }

    window.addEventListener(ORCA_EDITOR_FILE_SAVED_EVENT, handler as EventListener)
    return () => window.removeEventListener(ORCA_EDITOR_FILE_SAVED_EVENT, handler as EventListener)
  }, [])

  const [renameError, setRenameError] = useState<string | null>(null)

  const handleRenameConfirm = useCallback(
    async (newRelPath: string) => {
      if (!renameDialogFile) {
        return
      }
      const oldPath = renameDialogFile.filePath
      // Why: worktree path is derived by stripping the old relativePath
      // suffix, so subdirectory-relative names (e.g. "notes/ideas.md")
      // resolve correctly against the worktree root.
      const worktreeRoot = oldPath.slice(
        0,
        oldPath.length - renameDialogFile.relativePath.length - 1
      )
      const newPath = `${worktreeRoot}/${newRelPath}`

      // Prevent silently overwriting an existing file (but allow keeping
      // the current name — the file's own path is not a conflict).
      if (newPath !== oldPath && (await window.api.shell.pathExists(newPath))) {
        setRenameError('A file with that name already exists')
        return
      }

      // Why: Cmd+S no longer pre-saves for untitled files — it just opens
      // this dialog. Flush any pending autosave, then save the current
      // content so the file on disk is up-to-date before we rename it.
      await requestEditorSaveQuiesce({ fileId: renameDialogFile.id })
      // Why: only trigger a save if there's actually unsaved content.
      // Passing an empty fallbackContent when the draft is absent would
      // overwrite the file with nothing, wiping user content.
      const draft = useAppStore.getState().editorDrafts[renameDialogFile.id]
      if (draft !== undefined) {
        try {
          await requestEditorFileSave({ fileId: renameDialogFile.id, fallbackContent: draft })
        } catch {
          // Why: if the save fails (disk full, permissions, etc.), abort the
          // rename to avoid moving a stale/empty file and losing content.
          setRenameError('Failed to save file')
          return
        }
      }

      // User kept the same name — just save in place, no rename needed.
      if (newPath === oldPath) {
        clearUntitled(renameDialogFile.id)
        setRenameDialogFileId(null)
        setRenameError(null)
        return
      }

      // Why: if the target path includes subdirectories (e.g. "notes/ideas.md"),
      // ensure the parent directory exists before renaming. createDir throws
      // if the directory already exists (assertNotExists guard), so only call
      // it when the directory is not yet on disk.
      const newDir = newPath.slice(0, newPath.lastIndexOf('/'))
      if (newDir !== worktreeRoot && !(await window.api.shell.pathExists(newDir))) {
        await window.api.fs.createDir({ dirPath: newDir })
      }

      try {
        await window.api.fs.rename({ oldPath, newPath })
      } catch (err) {
        setRenameError(err instanceof Error ? err.message : 'Failed to rename file')
        return
      }

      closeFile(oldPath)
      openFile({
        filePath: newPath,
        relativePath: newRelPath,
        worktreeId: renameDialogFile.worktreeId,
        language: detectLanguage(newRelPath),
        mode: 'edit'
      })

      // Why: Cmd+S already saved the content before the rename dialog opened,
      // and quiesce flushed any remaining writes. The renamed file on disk
      // matches the editor content, so the new tab should start clean.

      setRenameDialogFileId(null)
      setRenameError(null)
    },
    [renameDialogFile, closeFile, openFile, clearUntitled]
  )

  const handleCopyPath = useCallback(async (): Promise<void> => {
    if (!activeFile) {
      return
    }
    const copyState = getEditorHeaderCopyState(activeFile)
    if (!copyState.copyText) {
      return
    }
    try {
      await window.api.ui.writeClipboardText(copyState.copyText)
      setCopiedPathToast({ fileId: activeFile.id, token: Date.now() })
    } catch {
      setCopiedPathToast(null)
    }
  }, [activeFile])

  useEffect(() => {
    if (!activeFilePath || !activeFileRelativePath || !activeFileWorktreeId || !activeFileMode) {
      return
    }

    const shortcutLanguage =
      activeFileMode === 'diff'
        ? detectLanguage(activeFileRelativePath)
        : detectLanguage(activeFilePath)
    const canShowMarkdownPreview = canOpenMarkdownPreview({
      language: shortcutLanguage,
      mode: activeFileMode,
      diffSource: activeFileDiffSource
    })
    if (!canShowMarkdownPreview) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || !isMarkdownPreviewShortcut(event, isMac)) {
        return
      }
      const root = panelRef.current
      if (!root) {
        return
      }
      const target = event.target
      const targetInsidePanel = target instanceof Node && root.contains(target)
      if (!targetInsidePanel) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      openMarkdownPreview({
        filePath: activeFilePath,
        relativePath: activeFileRelativePath,
        worktreeId: activeFileWorktreeId,
        language: shortcutLanguage
      })
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [
    activeFileDiffSource,
    activeFileMode,
    activeFilePath,
    activeFileRelativePath,
    activeFileWorktreeId,
    openMarkdownPreview
  ])

  if (!activeFile) {
    return null
  }

  const isSingleDiff =
    activeFile.mode === 'diff' &&
    activeFile.diffSource !== undefined &&
    activeFile.diffSource !== 'combined-uncommitted' &&
    activeFile.diffSource !== 'combined-branch'
  const isCombinedDiff =
    activeFile.mode === 'diff' &&
    (activeFile.diffSource === 'combined-uncommitted' ||
      activeFile.diffSource === 'combined-branch')
  const headerCopyState = getEditorHeaderCopyState(activeFile)
  const worktreeEntries = gitStatusByWorktree[activeFile.worktreeId] ?? []
  const branchEntries = gitBranchChangesByWorktree[activeFile.worktreeId] ?? []
  const resolvedLanguage =
    activeFile.mode === 'diff'
      ? detectLanguage(activeFile.relativePath)
      : detectLanguage(activeFile.filePath)
  const matchingWorktreeEntry =
    activeFile.mode === 'diff' && activeFile.diffSource !== 'branch'
      ? (worktreeEntries.find(
          (entry) =>
            entry.path === activeFile.relativePath &&
            (activeFile.diffSource === 'staged'
              ? entry.area === 'staged'
              : entry.area === 'unstaged')
        ) ?? null)
      : null
  const matchingBranchEntry =
    activeFile.mode === 'diff' && activeFile.diffSource === 'branch'
      ? (branchEntries.find((entry) => entry.path === activeFile.relativePath) ?? null)
      : null
  const openFileState = getEditorHeaderOpenFileState(
    activeFile,
    matchingWorktreeEntry,
    matchingBranchEntry
  )

  const isMarkdown = resolvedLanguage === 'markdown'
  const isMermaid = resolvedLanguage === 'mermaid'
  // Why: "Open Preview to the Side" only applies to edit-mode tabs whose
  // language has a registered renderer. Diff tabs already have their own
  // toggle set and there is no clear semantic for previewing a diff.
  const canOpenPreviewToSide = activeFile.mode === 'edit' && canPreviewLanguage(resolvedLanguage)
  const handleOpenPreviewToSide = (): void => {
    // Split-pane layouts mount one EditorPanel per pane, each with its own
    // activeViewStateId (the unified-tab id). Resolve the owning group from
    // that tab so the preview lands beside *this* pane rather than whichever
    // group happens to be the ambient active one.
    const state = useAppStore.getState()
    const sourceGroupId = activeViewStateId
      ? ((state.unifiedTabsByWorktree[activeFile.worktreeId] ?? []).find(
          (t) => t.id === activeViewStateId
        )?.groupId ?? null)
      : null
    openFilePreviewToSide({
      language: resolvedLanguage,
      filePath: activeFile.filePath,
      worktreeId: activeFile.worktreeId,
      sourceGroupId
    })
  }
  const markdownViewModes = getMarkdownViewModes({
    language: resolvedLanguage,
    mode: activeFile.mode,
    diffSource: activeFile.diffSource
  })
  const hasViewModeToggle = markdownViewModes.length > 0
  const defaultMarkdownViewMode = getDefaultMarkdownViewMode({
    language: resolvedLanguage,
    mode: activeFile.mode,
    diffSource: activeFile.diffSource
  })
  const storedMarkdownViewMode = markdownViewMode[activeFile.id]
  const mdViewMode: MarkdownViewMode =
    hasViewModeToggle &&
    storedMarkdownViewMode !== undefined &&
    markdownViewModes.includes(storedMarkdownViewMode)
      ? storedMarkdownViewMode
      : defaultMarkdownViewMode
  const canShowMarkdownPreview = canOpenMarkdownPreview({
    language: resolvedLanguage,
    mode: activeFile.mode,
    diffSource: activeFile.diffSource
  })

  const handleOpenDiffTargetFile = (): void => {
    if (!openFileState.canOpen) {
      return
    }
    openFile({
      filePath: activeFile.filePath,
      relativePath: activeFile.relativePath,
      worktreeId: activeFile.worktreeId,
      language: detectLanguage(activeFile.relativePath),
      mode: 'edit'
    })
  }

  const loadingFallback = (
    <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
      Loading editor...
    </div>
  )

  return (
    <div ref={panelRef} className="flex flex-col flex-1 min-w-0 min-h-0">
      {!isCombinedDiff && (
        <div className="editor-header">
          <div className="editor-header-text">
            <div
              className="editor-header-path-row"
              onContextMenuCapture={(event) => {
                event.preventDefault()
                window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
                setPathMenuPoint({ x: event.clientX, y: event.clientY })
                setPathMenuOpen(true)
              }}
            >
              <button
                type="button"
                className="editor-header-path"
                onClick={() => void handleCopyPath()}
                title={headerCopyState.pathTitle}
              >
                {headerCopyState.pathLabel}
              </button>
              <span
                className={`editor-header-copy-toast${copiedPathToast?.fileId === activeFile.id ? ' is-visible' : ''}`}
                aria-live="polite"
              >
                {headerCopyState.copyToastLabel}
              </span>
            </div>
            <DropdownMenu open={pathMenuOpen} onOpenChange={setPathMenuOpen} modal={false}>
              <DropdownMenuTrigger asChild>
                <button
                  aria-hidden
                  tabIndex={-1}
                  className="pointer-events-none fixed size-px opacity-0"
                  style={{ left: pathMenuPoint.x, top: pathMenuPoint.y }}
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-56" sideOffset={0} align="start">
                <DropdownMenuItem
                  onSelect={() => {
                    void window.api.ui.writeClipboardText(activeFile.filePath)
                  }}
                >
                  <Copy className="w-3.5 h-3.5 mr-1.5" />
                  Copy Path
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    void window.api.ui.writeClipboardText(activeFile.relativePath)
                  }}
                >
                  <Copy className="w-3.5 h-3.5 mr-1.5" />
                  Copy Relative Path
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {canShowMarkdownPreview && (
                  <DropdownMenuItem
                    onSelect={() =>
                      openMarkdownPreview({
                        filePath: activeFile.filePath,
                        relativePath: activeFile.relativePath,
                        worktreeId: activeFile.worktreeId,
                        language: resolvedLanguage
                      })
                    }
                  >
                    <Eye className="w-3.5 h-3.5 mr-1.5" />
                    Open Markdown Preview
                    <DropdownMenuShortcut>{markdownPreviewShortcutLabel}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                )}
                {canShowMarkdownPreview && <DropdownMenuSeparator />}
                <DropdownMenuItem
                  onSelect={() => {
                    window.api.shell.openPath(activeFile.filePath)
                  }}
                >
                  <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
                  {revealLabel}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {isSingleDiff && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors flex-shrink-0 disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                    onClick={handleOpenDiffTargetFile}
                    aria-label="Open file"
                    disabled={!openFileState.canOpen}
                  >
                    <FileText size={14} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={4}>
                  {openFileState.canOpen
                    ? isMarkdown
                      ? 'Open file tab to use rich markdown editing'
                      : 'Open file tab'
                    : 'This diff has no modified-side file to open'}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {canOpenPreviewToSide && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                    onClick={handleOpenPreviewToSide}
                    aria-label="Open Preview to the Side"
                  >
                    <Eye size={14} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={4}>
                  Open Preview to the Side
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {isSingleDiff && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                    onClick={() => setSideBySide((prev) => !prev)}
                  >
                    {sideBySide ? <Rows2 size={14} /> : <Columns2 size={14} />}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={4}>
                  {sideBySide ? 'Switch to inline diff' : 'Switch to side-by-side diff'}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {hasViewModeToggle && (
            <MarkdownViewToggle
              mode={mdViewMode}
              modes={markdownViewModes}
              onChange={(mode) => setMarkdownViewMode(activeFile.id, mode)}
            />
          )}
          {hasViewModeToggle && isMarkdown && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                  aria-label="More actions"
                  title="More actions"
                >
                  <MoreHorizontal size={14} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={4}>
                <DropdownMenuItem
                  // Why: the item is disabled (not hidden) only in source/Monaco
                  // mode, which has no document DOM to export. We intentionally
                  // don't poll the DOM (canExportActiveMarkdown) at render time:
                  // the Radix content renders in a Portal and the lookup can
                  // race with the active surface's paint, producing a stuck
                  // disabled state. exportActiveMarkdownToPdf is a safe no-op
                  // when no subtree is found.
                  disabled={mdViewMode === 'source'}
                  onSelect={() => {
                    void exportActiveMarkdownToPdf()
                  }}
                >
                  Export as PDF
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
      <Suspense fallback={loadingFallback}>
        <EditorContent
          activeFile={activeFile}
          viewStateScopeId={activeViewStateId ?? activeFile.id}
          fileContents={fileContents}
          diffContents={diffContents}
          editBuffers={editorDrafts}
          worktreeEntries={worktreeEntries}
          resolvedLanguage={resolvedLanguage}
          isMarkdown={isMarkdown}
          isMermaid={isMermaid}
          mdViewMode={mdViewMode}
          sideBySide={sideBySide}
          pendingEditorReveal={pendingEditorReveal}
          handleContentChange={handleContentChange}
          handleDirtyStateHint={handleDirtyStateHint}
          handleSave={handleSave}
        />
      </Suspense>
      <UntitledFileRenameDialog
        open={renameDialogFile !== undefined && renameDialogFile !== null}
        currentName={renameDialogFile?.relativePath ?? ''}
        worktreePath={
          renameDialogFile
            ? (findWorktreeById(useAppStore.getState().worktreesByRepo, renameDialogFile.worktreeId)
                ?.path ?? '')
            : ''
        }
        externalError={renameError}
        onClose={() => {
          setRenameDialogFileId(null)
          setRenameError(null)
        }}
        onConfirm={handleRenameConfirm}
      />
    </div>
  )
}

export default React.memo(EditorPanelInner)
