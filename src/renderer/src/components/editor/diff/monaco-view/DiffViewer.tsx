import { NO_RESOURCE_EVIDENCE } from '@/lib/workspace/ownership/workspace-copy-owner'
import {
  useDiffCommentView,
  useOwnedDiffCommentTarget
} from '@/components/diff-comments/use-diff-comment-owner'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { PostRenderPhase } from '@pierre/diffs'
import { useAppStore } from '@/store'
import type { DecoratedDiffComment } from '@/components/diff-comments/decorated-diff-comment'
import { isDiffComment } from '@/lib/source-control/review/comments/diff-comment-compat'
import { installEditorSaveShortcut } from '@/components/editor/commands/editor-shortcuts'
import { LargeDiffFallback } from '@/components/editor/diff/large-files/LargeDiffFallback'
import { getLargeDiffRenderLimit } from '../../../../../../shared/source-control/diff/large-diff-render-limit'
import { getDiffViewerLargeDiffSaveAction } from '@/components/editor/diff/large-files/diff-viewer-large-diff-save-action'
import type { DiffViewerProps } from './diff-viewer-props'
import {
  useDiffNavigatorRegistration,
  type DiffNavigator
} from '@/components/editor/diff/review/diff-navigation-context'
import { PierreDiffProviders } from '@/components/editor/pierre-diff/PierreDiffProviders'
import {
  PierreDiffSurface,
  type PierreDiffInstance
} from '@/components/editor/pierre-diff/PierreDiffSurface'
import type { PierreDiffInput } from '@/components/editor/pierre-diff/pierre-diff-metadata'
import { usePierreFileDiff } from '@/components/editor/pierre-diff/use-pierre-file-diff'
import { PierreDiffLoading } from '@/components/editor/pierre-diff/PierreDiffLoading'
import { buildPierreParseDiffOptions } from '@/components/editor/pierre-diff/pierre-diff-options'
import { scrollPierreDiffToLine } from '@/components/editor/pierre-diff/pierre-diff-scroll'
import { usePierreDiffScrollRestore } from '@/components/editor/pierre-diff/use-pierre-diff-scroll-restore'
import { getPierreDiffChangeTargets } from '@/components/editor/pierre-diff/pierre-diff-change-targets'
import { usePierreDiffLanguage } from '@/components/editor/pierre-diff/pierre-diff-language'

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
  noteSource = NO_RESOURCE_EVIDENCE,
  onAddLineComment,
  commentableLineNumbers,
  addLineCommentLabel,
  addLineCommentPlaceholder,
  onContentChange,
  onSave,
  largeDiffRenderLimit,
  largeDiffSaveContentAvailable
}: DiffViewerProps): React.JSX.Element {
  const diffWordWrap = useAppStore((s) => s.settings?.diffWordWrap)
  const diffShowWhitespace = useAppStore((s) => s.settings?.diffShowWhitespace)
  const diffCollapseUnchangedRegions = useAppStore((s) => s.settings?.diffCollapseUnchangedRegions)
  const settings = useMemo(
    () => ({ diffWordWrap, diffShowWhitespace }),
    [diffWordWrap, diffShowWhitespace]
  )
  const addDiffComment = useAppStore((s) => s.addDiffComment)
  const deleteDiffComment = useAppStore((s) => s.deleteDiffComment)
  const updateDiffComment = useAppStore((s) => s.updateDiffComment)
  const { owner: commentOwner, comments: allDiffComments } = useDiffCommentView(
    worktreeId,
    noteSource
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
  const pierreInstanceRef = useRef<PierreDiffInstance | null>(null)
  const [pendingComment, setPendingComment, draftOwner] = useOwnedDiffCommentTarget<{
    lineNumber: number
    startLine?: number
  }>(worktreeId, noteSource, `note:${modelKey}`)

  const renderLimit = useMemo(
    () =>
      largeDiffRenderLimit?.limited
        ? largeDiffRenderLimit
        : getLargeDiffRenderLimit({ originalContent, modifiedContent }),
    [largeDiffRenderLimit, originalContent, modifiedContent]
  )
  const hasLineCommentAction = Boolean(commentOwner || onAddLineComment)
  const lang = usePierreDiffLanguage(relativePath, language)

  const diffInput = useMemo<PierreDiffInput | null>(
    () =>
      renderLimit.limited
        ? null
        : {
            path: relativePath,
            status: 'modified',
            originalContent,
            modifiedContent,
            cacheKey: modelKey,
            lang,
            parseDiffOptions: buildPierreParseDiffOptions(settings?.diffShowWhitespace)
          },
    [
      lang,
      relativePath,
      originalContent,
      modifiedContent,
      modelKey,
      settings?.diffShowWhitespace,
      renderLimit.limited
    ]
  )

  const {
    fileDiff,
    error: parseError,
    retry: retryParse,
    markEdited,
    editReady
  } = usePierreFileDiff(diffInput, editable)

  const { registerDiffNavigator, unregisterDiffNavigator } = useDiffNavigatorRegistration()
  const changeTargets = useMemo(() => getPierreDiffChangeTargets(fileDiff), [fileDiff])
  const changeLines = useMemo(
    () => changeTargets.map((target) => target.lineNumber),
    [changeTargets]
  )

  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container || renderLimit.limited) {
      return
    }
    const navigator: DiffNavigator = {
      id: modelKey,
      changeLines,
      container,
      scrollToChange: ({ lineNumber, hunkIndex, hunkCount }) => {
        scrollPierreDiffToLine({
          host: pierreHostRef.current,
          container,
          lineNumber,
          side: changeTargets[hunkIndex]?.side,
          linePosition: pierreInstanceRef.current?.getLinePosition?.(
            lineNumber,
            changeTargets[hunkIndex]?.side
          ),
          hunkIndex,
          hunkCount
        })
      }
    }
    registerDiffNavigator(navigator)
    return () => unregisterDiffNavigator(navigator)
  }, [
    changeLines,
    changeTargets,
    modelKey,
    registerDiffNavigator,
    renderLimit.limited,
    unregisterDiffNavigator
  ])

  const requestedCommentId = useAppStore((s) => s.scrollToDiffCommentId)
  const pendingScrollCommentId = diffComments.some((comment) => comment.id === requestedCommentId)
    ? requestedCommentId
    : null
  const restoreScroll = usePierreDiffScrollRestore(
    modelKey,
    scrollContainerRef,
    fileDiff,
    pendingScrollCommentId
  )
  const handlePostRender = useCallback(
    (node: HTMLElement, phase: PostRenderPhase, instance: PierreDiffInstance) => {
      pierreHostRef.current = phase === 'unmount' ? null : node
      pierreInstanceRef.current = phase === 'unmount' ? null : instance
      restoreScroll(node, phase, instance)
    },
    [restoreScroll]
  )

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
      markEdited()
      modifiedContentRef.current = file.contents
      onContentChange?.(file.contents)
    },
    [onContentChange, markEdited]
  )

  const handleAddComment = useCallback(
    (range: { lineNumber: number; startLine?: number }) => {
      if (commentableLineNumbers && !commentableLineNumbers.includes(range.lineNumber)) {
        return
      }
      setPendingComment(range)
    },
    [commentableLineNumbers, setPendingComment]
  )

  const handleSubmitComment = useCallback(
    async (body: string): Promise<boolean> => {
      if (!pendingComment) {
        return false
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
        return ok
      }
      if (!worktreeId) {
        return false
      }
      // Why: await persistence — a null result (failed save) keeps the draft open for retry.
      const result = await (draftOwner.current
        ? addDiffComment(draftOwner.current, {
            worktreeId,
            filePath: relativePath,
            source: 'diff',
            startLine: pendingComment.startLine,
            lineNumber: pendingComment.lineNumber,
            body,
            side: 'modified'
          })
        : null)
      if (result) {
        setPendingComment(null)
      } else {
        // The draft stays open for retry.
        toast.error(
          translate('auto.components.editor.diffCommentSaveFailed', 'Failed to save comment')
        )
      }
      return Boolean(result)
    },
    [
      draftOwner,
      addDiffComment,
      onAddLineComment,
      pendingComment,
      relativePath,
      worktreeId,
      setPendingComment
    ]
  )

  const handleDeleteComment = useCallback(
    (id: string) => {
      if (worktreeId) {
        void (commentOwner && deleteDiffComment(commentOwner, id))
      }
    },
    [commentOwner, deleteDiffComment, worktreeId]
  )

  const handleUpdateComment = useMemo(
    () =>
      worktreeId
        ? (id: string, body: string) =>
            commentOwner ? updateDiffComment(commentOwner, id, body) : Promise.resolve(false)
        : undefined,
    [commentOwner, updateDiffComment, worktreeId]
  )

  return (
    <div className="relative flex flex-col flex-1 min-h-0">
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
        ) : fileDiff ? (
          <PierreDiffProviders scrollContainerRef={scrollContainerRef}>
            {parseError ? <PierreDiffLoading error={parseError} onRetry={retryParse} /> : null}
            <PierreDiffSurface
              key={modelKey}
              fileDiff={fileDiff}
              modifiedContent={modifiedContent}
              sideBySide={sideBySide}
              settings={settings}
              isEditable={Boolean(editable)}
              editReady={editReady}
              editStateKey={modelKey}
              collapseUnchanged={diffCollapseUnchangedRegions === true}
              autoFocusHost
              worktreeId={worktreeId ?? ''}
              filePath={relativePath}
              language={language}
              commentOwner={commentOwner}
              comments={comments}
              onDeleteComment={handleDeleteComment}
              onUpdateComment={handleUpdateComment}
              onEditChange={handleEditChange}
              onPostRender={handlePostRender}
              onAddComment={hasLineCommentAction ? handleAddComment : undefined}
              commentableLineNumbers={commentableLineNumbers}
              pendingComment={pendingComment}
              addCommentPlaceholder={addLineCommentPlaceholder}
              addCommentLabel={addLineCommentLabel}
              onCancelComment={() => setPendingComment(null)}
              onSubmitComment={handleSubmitComment}
            />
          </PierreDiffProviders>
        ) : (
          <PierreDiffLoading error={parseError} onRetry={retryParse} />
        )}
      </div>
    </div>
  )
}
