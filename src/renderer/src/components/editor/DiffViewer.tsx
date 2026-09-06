import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PostRenderPhase } from '@pierre/diffs'
import { useAppStore } from '@/store'
import { diffScrollTopCache, setWithLRU } from '@/lib/scroll-cache'
import { selectWorktreeDiffComments } from '@/store/worktree-diff-comments-selector'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import type { DecoratedDiffComment } from '../diff-comments/decorated-diff-comment'
import { isDiffComment } from '@/lib/diff-comment-compat'
import { installEditorSaveShortcut } from './editor-shortcuts'
import { LargeDiffFallback } from './LargeDiffFallback'
import { getLargeDiffRenderLimit } from './large-diff-render-limit'
import { getDiffViewerLargeDiffSaveAction } from './diff-viewer-large-diff-save-action'
import type { DiffViewerProps } from './diff-viewer-props'
import { useDiffNavigatorRegistration, type DiffNavigator } from './diff-navigation-context'
import { PierreDiffProviders } from './pierre-diff/PierreDiffProviders'
import { PierreDiffSurface } from './pierre-diff/PierreDiffSurface'
import { buildPierreFileDiff } from './pierre-diff/pierre-diff-metadata'
import { buildPierreParseDiffOptions } from './pierre-diff/pierre-diff-options'
import { scrollPierreDiffToLine } from './pierre-diff/pierre-diff-scroll'

const EMPTY_DIFF_COMMENTS: readonly DecoratedDiffComment[] = []

export default function DiffViewer({
  modelKey,
  originalContent,
  modifiedContent,
  relativePath,
  language,
  sideBySide,
  editable,
  worktreeId,
  onAddLineComment,
  commentableLineNumbers,
  addLineCommentLabel,
  addLineCommentPlaceholder,
  onContentChange,
  onSave,
  largeDiffRenderLimit,
  largeDiffSaveContentAvailable
}: DiffViewerProps): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const addDiffComment = useAppStore((s) => s.addDiffComment)
  const deleteDiffComment = useAppStore((s) => s.deleteDiffComment)
  const updateDiffComment = useAppStore((s) => s.updateDiffComment)
  // Why: subscribe to the raw array so selector identity only changes when this worktree's comments change; filtering happens below.
  const allDiffComments = useAppStore((s): DiffComment[] | undefined =>
    selectWorktreeDiffComments(s, worktreeId)
  )
  const diffComments = useMemo(
    () => (allDiffComments ?? []).filter((c) => c.filePath === relativePath && isDiffComment(c)),
    [allDiffComments, relativePath]
  )
  const comments = useMemo(
    () => (worktreeId ? diffComments : EMPTY_DIFF_COMMENTS),
    [diffComments, worktreeId]
  )

  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const pierreHostRef = useRef<HTMLElement | null>(null)
  const [pendingComment, setPendingComment] = useState<{
    lineNumber: number
    startLine?: number
  } | null>(null)

  const renderLimit = useMemo(
    () => largeDiffRenderLimit ?? getLargeDiffRenderLimit({ originalContent, modifiedContent }),
    [largeDiffRenderLimit, originalContent, modifiedContent]
  )
  const hasLineCommentAction = Boolean(worktreeId || onAddLineComment)

  const fileDiff = useMemo(
    () =>
      buildPierreFileDiff({
        path: relativePath,
        status: 'modified',
        originalContent,
        modifiedContent,
        cacheKey: modelKey,
        parseDiffOptions: buildPierreParseDiffOptions(settings?.diffShowWhitespace)
      }),
    [relativePath, originalContent, modifiedContent, modelKey, settings?.diffShowWhitespace]
  )

  const { registerDiffNavigator, unregisterDiffNavigator } = useDiffNavigatorRegistration()
  const changeLines = useMemo(() => fileDiff.hunks.map((hunk) => hunk.additionStart), [fileDiff])

  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container || renderLimit.limited) {
      return
    }
    const navigator: DiffNavigator = {
      changeLines,
      container,
      scrollToChange: ({ lineNumber, hunkIndex, hunkCount }) => {
        scrollPierreDiffToLine({
          host: pierreHostRef.current,
          container,
          lineNumber,
          hunkIndex,
          hunkCount
        })
      }
    }
    registerDiffNavigator(navigator)
    return () => unregisterDiffNavigator(navigator)
  }, [changeLines, registerDiffNavigator, renderLimit.limited, unregisterDiffNavigator])

  const handlePostRender = useCallback((node: HTMLElement, phase: PostRenderPhase) => {
    pierreHostRef.current = phase === 'unmount' ? null : node
  }, [])

  // Why: restore scroll after the first paint so Pierre has laid out its rows.
  useEffect(() => {
    const container = scrollContainerRef.current
    const saved = diffScrollTopCache.get(modelKey)
    if (!container || saved === undefined) {
      return
    }
    const frame = requestAnimationFrame(() => {
      container.scrollTop = saved
    })
    return () => cancelAnimationFrame(frame)
  }, [modelKey])

  // Why: snapshot on deactivation (layout-effect cleanup runs before unmount), not on every scroll event.
  useLayoutEffect(() => {
    // Why: capture the node now — the same div serves this modelKey for the
    // effect's whole life, and reading the ref at cleanup races unmount.
    const container = scrollContainerRef.current
    return () => {
      if (container) {
        setWithLRU(diffScrollTopCache, modelKey, container.scrollTop)
      }
    }
  }, [modelKey])

  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const modifiedContentRef = useRef(modifiedContent)
  // Why: reseed only when the prop actually changes. Pierre owns the live
  // document and `onContentChange` only catches up after a state round-trip, so
  // assigning every render lets an unrelated re-render mid-edit reset what
  // Cmd+S writes back to disk.
  useEffect(() => {
    modifiedContentRef.current = modifiedContent
  }, [modifiedContent])

  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container || !editable) {
      return
    }
    return installEditorSaveShortcut(container, () => {
      onSaveRef.current?.(modifiedContentRef.current)
    })
  }, [editable])

  const handleEditChange = useCallback(
    (file: { contents: string }) => {
      modifiedContentRef.current = file.contents
      onContentChange?.(file.contents)
    },
    [onContentChange]
  )

  const handleAddComment = useCallback(
    (range: { lineNumber: number; startLine?: number }) => {
      if (commentableLineNumbers && !commentableLineNumbers.includes(range.lineNumber)) {
        return
      }
      setPendingComment(range)
    },
    [commentableLineNumbers]
  )

  const handleSubmitComment = useCallback(
    async (body: string): Promise<void> => {
      if (!pendingComment) {
        return
      }
      if (onAddLineComment) {
        const ok = await onAddLineComment({
          lineNumber: pendingComment.lineNumber,
          startLine: pendingComment.startLine,
          body
        })
        if (ok) {
          setPendingComment(null)
        }
        return
      }
      if (!worktreeId) {
        return
      }
      // Why: await persistence — a null result (failed save) keeps the draft open for retry.
      const result = await addDiffComment({
        worktreeId,
        filePath: relativePath,
        source: 'diff',
        startLine: pendingComment.startLine,
        lineNumber: pendingComment.lineNumber,
        body,
        side: 'modified'
      })
      if (result) {
        setPendingComment(null)
      } else {
        console.error('Failed to add diff comment — draft preserved')
      }
    },
    [addDiffComment, onAddLineComment, pendingComment, relativePath, worktreeId]
  )

  const handleDeleteComment = useCallback(
    (id: string) => {
      if (worktreeId) {
        void deleteDiffComment(worktreeId, id)
      }
    },
    [deleteDiffComment, worktreeId]
  )

  const handleUpdateComment = useMemo(
    () =>
      worktreeId
        ? (id: string, body: string) => updateDiffComment(worktreeId, id, body)
        : undefined,
    [updateDiffComment, worktreeId]
  )

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div ref={scrollContainerRef} className="flex-1 min-h-0 overflow-auto scrollbar-editor">
        {renderLimit.limited ? (
          <LargeDiffFallback
            filePath={relativePath}
            renderLimit={renderLimit}
            action={getDiffViewerLargeDiffSaveAction({
              editable,
              modifiedContent,
              onSave,
              saveContentAvailable: largeDiffSaveContentAvailable
            })}
          />
        ) : (
          <PierreDiffProviders>
            <PierreDiffSurface
              fileDiff={fileDiff}
              sideBySide={sideBySide}
              settings={settings}
              isEditable={Boolean(editable)}
              collapseUnchanged={false}
              worktreeId={worktreeId ?? ''}
              filePath={relativePath}
              language={language}
              comments={comments}
              onDeleteComment={handleDeleteComment}
              onUpdateComment={handleUpdateComment}
              onEditChange={handleEditChange}
              onPostRender={handlePostRender}
              onAddComment={hasLineCommentAction ? handleAddComment : undefined}
              pendingComment={pendingComment}
              addCommentPlaceholder={addLineCommentPlaceholder}
              addCommentLabel={addLineCommentLabel}
              onCancelComment={() => setPendingComment(null)}
              onSubmitComment={handleSubmitComment}
            />
          </PierreDiffProviders>
        )}
      </div>
    </div>
  )
}
