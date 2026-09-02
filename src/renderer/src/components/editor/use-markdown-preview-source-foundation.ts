import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createConnectionIdForFileSelector } from '@/lib/connection-owner-resolution'
import { computeEditorFontSize } from '@/lib/editor-font-zoom'
import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'
import { isMarkdownComment } from '@/lib/diff-comment-compat'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import { prewarmMarkdownPreviewLocalImages } from './markdown-preview-local-images'
import {
  deriveMarkdownPreviewSourceRoot,
  findMarkdownPreviewSourceOpenFile,
  getMarkdownPreviewSourceRelativePath,
  resolveMarkdownPreviewSourceWorktree
} from './markdown-preview-source-routing'
import { usePreserveSectionDuringExternalEdit } from './usePreserveSectionDuringExternalEdit'

export function useMarkdownPreviewSourceFoundation({
  content,
  filePath,
  sourceFileId,
  sourceWorktreeId,
  sourceRuntimeEnvironmentId
}: {
  content: string
  filePath: string
  sourceFileId: string | null
  sourceWorktreeId: string | null
  sourceRuntimeEnvironmentId: string | null | undefined
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const setSearchInputElement = useCallback((input: HTMLInputElement | null) => {
    inputRef.current = input
    if (!input) {
      return
    }
    // Why: select the query once on open; match-count updates must not re-select it.
    input.focus()
    input.select()
  }, [])
  const matchesRef = useRef<Range[]>([])
  const searchInstanceRef = useRef<object>({})
  const lastAppliedInitialAnchorRef = useRef<string | null>(null)
  const pendingEditorRevealFrameIdsRef = useRef<number[]>([])
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [matchCount, setMatchCount] = useState(0)
  const [searchRevision, setSearchRevision] = useState(0)
  const [activeMatchIndex, setActiveMatchIndex] = useState(-1)
  const isMac = navigator.userAgent.includes('Mac')
  const openFile = useAppStore((s) => s.openFile)
  const activateMarkdownLink = useAppStore((s) => s.activateMarkdownLink)
  const openMarkdownPreview = useAppStore((s) => s.openMarkdownPreview)
  const setMarkdownViewMode = useAppStore((s) => s.setMarkdownViewMode)
  const frontmatterVisibleByFile = useAppStore((s) => s.markdownFrontmatterVisible)
  const setPendingEditorReveal = useAppStore((s) => s.setPendingEditorReveal)
  const addDiffComment = useAppStore((s) => s.addDiffComment)
  const deleteDiffComment = useAppStore((s) => s.deleteDiffComment)
  const updateDiffComment = useAppStore((s) => s.updateDiffComment)
  const clearDeliveredDiffComments = useAppStore((s) => s.clearDeliveredDiffComments)
  const keybindings = useAppStore((s) => s.keybindings)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const sourceOpenFile = useAppStore((s) =>
    findMarkdownPreviewSourceOpenFile(s.openFiles, {
      sourceFileId,
      filePath,
      sourceWorktreeId,
      sourceRuntimeEnvironmentId
    })
  )
  const resolvedSourceWorktreeId = sourceWorktreeId ?? sourceOpenFile?.worktreeId ?? null
  const resolvedSourceRuntimeEnvironmentId =
    sourceRuntimeEnvironmentId !== undefined
      ? sourceRuntimeEnvironmentId
      : sourceOpenFile?.runtimeEnvironmentId
  const sourceWorktree = resolveMarkdownPreviewSourceWorktree(
    worktreesByRepo,
    resolvedSourceWorktreeId,
    filePath
  )
  const allDiffComments = sourceWorktree?.diffComments
  const sourceRoutingWorktreeId = sourceWorktree?.id ?? resolvedSourceWorktreeId
  const runtimeOwnerId = resolvedSourceRuntimeEnvironmentId?.trim()
  const sourceConnectionIdSelector = useMemo(
    () =>
      createConnectionIdForFileSelector(sourceRoutingWorktreeId, filePath, {
        skip: Boolean(runtimeOwnerId)
      }),
    [filePath, runtimeOwnerId, sourceRoutingWorktreeId]
  )
  const sourceConnectionId = useAppStore(sourceConnectionIdSelector)
  const sourceOwner = useMemo<HttpLinkSourceOwner>(
    () =>
      runtimeOwnerId
        ? { kind: 'runtime', runtimeEnvironmentId: runtimeOwnerId }
        : sourceConnectionId === undefined
          ? { kind: 'unknown' }
          : sourceConnectionId === null
            ? { kind: 'local' }
            : { kind: 'ssh', connectionId: sourceConnectionId },
    [runtimeOwnerId, sourceConnectionId]
  )
  const worktreeRoot =
    sourceWorktree?.path ??
    (sourceRoutingWorktreeId
      ? deriveMarkdownPreviewSourceRoot(filePath, sourceOpenFile?.relativePath)
      : null)
  const sourceRelativePath = useMemo(() => {
    if (!sourceWorktree) {
      return null
    }
    return getMarkdownPreviewSourceRelativePath(filePath, sourceWorktree.path)
  }, [filePath, sourceWorktree])
  const markdownComments = useMemo(
    () =>
      (allDiffComments ?? []).filter(
        (comment) => comment.filePath === sourceRelativePath && isMarkdownComment(comment)
      ),
    [allDiffComments, sourceRelativePath]
  )
  const settings = useAppStore((s) => s.settings)
  const imageRuntimeContext = useMemo(
    () =>
      sourceRoutingWorktreeId && worktreeRoot
        ? {
            settings: settingsForRuntimeOwner(settings, resolvedSourceRuntimeEnvironmentId),
            worktreeId: sourceRoutingWorktreeId,
            worktreePath: worktreeRoot,
            connectionId: sourceConnectionId,
            expectedExternalSshTargetId: sourceOpenFile?.externalSshTargetId
          }
        : undefined,
    [
      settings,
      sourceConnectionId,
      sourceOpenFile?.externalSshTargetId,
      resolvedSourceRuntimeEnvironmentId,
      sourceRoutingWorktreeId,
      worktreeRoot
    ]
  )
  const editorFontZoomLevel = useAppStore((s) => s.editorFontZoomLevel)
  const editorFontSize = computeEditorFontSize(14, editorFontZoomLevel)
  const isDark =
    settings?.theme === 'dark' ||
    (settings?.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  const renderedContent = usePreserveSectionDuringExternalEdit(content, bodyRef)

  useEffect(() => {
    const prewarm = prewarmMarkdownPreviewLocalImages(renderedContent, filePath, {
      runtimeContext: imageRuntimeContext
    })
    return prewarm.cancel
  }, [renderedContent, filePath, imageRuntimeContext])

  return {
    rootRef,
    bodyRef,
    inputRef,
    setSearchInputElement,
    matchesRef,
    searchInstanceRef,
    lastAppliedInitialAnchorRef,
    pendingEditorRevealFrameIdsRef,
    isSearchOpen,
    setIsSearchOpen,
    query,
    setQuery,
    matchCount,
    setMatchCount,
    searchRevision,
    setSearchRevision,
    activeMatchIndex,
    setActiveMatchIndex,
    isMac,
    openFile,
    activateMarkdownLink,
    openMarkdownPreview,
    setMarkdownViewMode,
    frontmatterVisibleByFile,
    setPendingEditorReveal,
    addDiffComment,
    deleteDiffComment,
    updateDiffComment,
    clearDeliveredDiffComments,
    keybindings,
    worktreesByRepo,
    sourceWorktree,
    sourceRoutingWorktreeId,
    sourceConnectionId,
    sourceOwner,
    worktreeRoot,
    sourceRelativePath,
    markdownComments,
    imageRuntimeContext,
    editorFontSize,
    isDark,
    renderedContent,
    resolvedSourceRuntimeEnvironmentId
  }
}

export type MarkdownPreviewSourceFoundation = ReturnType<typeof useMarkdownPreviewSourceFoundation>
