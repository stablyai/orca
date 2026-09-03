import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PostRenderPhase } from '@pierre/diffs'
import { useAppStore } from '@/store'
import { selectWorktreeDiffComments } from '@/store/worktree-diff-comments-selector'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import { isDiffComment } from '@/lib/diff-comment-compat'
import { installEditorSaveShortcut } from './editor-shortcuts'
import { DiffSectionHeader } from './DiffSectionHeader'
import { DiffSectionBody } from './DiffSectionBody'
import { useDiffSectionLayoutMetrics } from './useDiffSectionLayoutMetrics'
import { getLiveDiffSectionRenderLimit } from './diff-section-live-render-limit'
import { useDiffSectionFallbackCleanup } from './useDiffSectionFallbackCleanup'
import { submitDiffSectionComment } from './diff-section-comment-submit'
import type { DiffSectionItemProps } from './diff-section-item-props'
import { PierreDiffSurface } from './pierre-diff/PierreDiffSurface'
import { buildPierreFileDiff } from './pierre-diff/pierre-diff-metadata'
import { buildPierreParseDiffOptions } from './pierre-diff/pierre-diff-options'
import type { DecoratedDiffComment } from '../diff-comments/decorated-diff-comment'

const EMPTY_DIFF_COMMENTS: readonly DecoratedDiffComment[] = []

export function DiffSectionItem({
  section,
  index,
  isBranchMode,
  sideBySide,
  settings,
  sectionHeight,
  worktreeId,
  loadSection,
  loadDeferredSection,
  retrySection,
  toggleSection,
  openSection,
  openSectionTitle,
  onOpenPreview,
  renderHeaderTrailingContent,
  onAddLineComment,
  addLineCommentLabel,
  addLineCommentPlaceholder,
  inlineComments,
  getCommentableLineNumbers,
  setSectionHeights,
  setSections,
  handleSectionSaveRef
}: DiffSectionItemProps): React.JSX.Element {
  const addDiffComment = useAppStore((s) => s.addDiffComment)
  const deleteDiffComment = useAppStore((s) => s.deleteDiffComment)
  const updateDiffComment = useAppStore((s) => s.updateDiffComment)
  // Why: subscribe to the raw comments array on the worktree (reference-
  // stable across unrelated store updates) and filter by filePath inside a
  // memo. Selecting a fresh `.filter(...)` result would invalidate on every
  // store change and cause needless re-renders of this section.
  const allDiffComments = useAppStore((s): DiffComment[] | undefined =>
    selectWorktreeDiffComments(s, worktreeId)
  )
  const diffComments = useMemo(
    () => (allDiffComments ?? []).filter((c) => c.filePath === section.path && isDiffComment(c)),
    [allDiffComments, section.path]
  )
  const isEditable = section.area === 'unstaged'
  const hasLineCommentAction = Boolean(worktreeId || onAddLineComment)

  const sectionBodyRef = useRef<HTMLDivElement | null>(null)
  const [pendingComment, setPendingComment] = useState<{
    lineNumber: number
    startLine?: number
  } | null>(null)

  // Why: a fresh `[]` fallback would invalidate every memo that reads comments.
  const comments = useMemo(
    () => inlineComments ?? (worktreeId ? diffComments : EMPTY_DIFF_COMMENTS),
    [diffComments, inlineComments, worktreeId]
  )
  // Why: PR review only accepts comments on lines GitHub exposes in the patch.
  const commentableLineNumbers = getCommentableLineNumbers?.(section)
  const handleAddComment = useCallback(
    (range: { lineNumber: number; startLine?: number }) => {
      if (commentableLineNumbers && !commentableLineNumbers.includes(range.lineNumber)) {
        return
      }
      setPendingComment(range)
    },
    [commentableLineNumbers]
  )

  const fileDiff = useMemo(
    () =>
      buildPierreFileDiff({
        path: section.path,
        oldPath: section.oldPath,
        status: section.status,
        originalContent: section.originalContent,
        modifiedContent: section.modifiedContent,
        // Why: keyed by content generation so the worker AST cache survives virtualization remounts.
        cacheKey: `${section.key}:${section.contentGeneration ?? 0}`,
        parseDiffOptions: buildPierreParseDiffOptions(settings?.diffShowWhitespace)
      }),
    [
      section.path,
      section.oldPath,
      section.status,
      section.originalContent,
      section.modifiedContent,
      section.key,
      section.contentGeneration,
      settings?.diffShowWhitespace
    ]
  )

  // Why: virtualized rows unmount when scrolled away, so the draft must live in
  // section state rather than only inside the mounted editor.
  const handleEditChange = useCallback(
    (file: { contents: string }) => {
      const current = file.contents
      setSections((prev) => {
        let changed = false
        const next = prev.map((s, i) => {
          if (i !== index) {
            return s
          }
          const savedModifiedContent =
            s.diffResult?.kind === 'text' ? s.diffResult.modifiedContent : s.modifiedContent
          const dirty = current !== savedModifiedContent
          if (s.modifiedContent === current && s.dirty === dirty) {
            return s
          }
          changed = true
          return {
            ...s,
            modifiedContent: current,
            dirty,
            largeDiffRenderLimit: getLiveDiffSectionRenderLimit({
              section: s,
              modifiedContent: current
            })
          }
        })
        return changed ? next : prev
      })
    },
    [index, setSections]
  )

  const handlePostRender = useCallback(
    (node: HTMLElement, phase: PostRenderPhase) => {
      if (phase === 'unmount') {
        return
      }
      const contentHeight = node.scrollHeight
      setSectionHeights((prev) =>
        prev[index] === contentHeight ? prev : { ...prev, [index]: contentHeight }
      )
    },
    [index, setSectionHeights]
  )

  const handleSubmitComment = useCallback(
    async (body: string): Promise<void> => {
      if (!pendingComment) {
        return
      }
      const submitted = await submitDiffSectionComment({
        addDiffComment,
        body,
        onAddLineComment,
        popover: pendingComment,
        section,
        worktreeId
      })
      if (submitted) {
        setPendingComment(null)
      }
    },
    [addDiffComment, onAddLineComment, pendingComment, section, worktreeId]
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

  const { lineStats, sectionBodyHeight, useIntrinsicImageHeight, isLargeDiffLimited } =
    useDiffSectionLayoutMetrics({ section, sectionHeight })

  useDiffSectionFallbackCleanup({ index, isLargeDiffLimited, setSectionHeights })

  useEffect(() => {
    loadSection(index)
  }, [index, loadSection])

  // Why: the save chord lives on the section root now that no editor owns a container node.
  useEffect(() => {
    const node = sectionBodyRef.current
    if (!node || !isEditable) {
      return
    }
    return installEditorSaveShortcut(node, () => void handleSectionSaveRef.current(index))
  }, [handleSectionSaveRef, index, isEditable])

  const renderDiff = useCallback(
    () => (
      <PierreDiffSurface
        fileDiff={fileDiff}
        sideBySide={sideBySide}
        settings={settings}
        isEditable={isEditable}
        worktreeId={worktreeId ?? ''}
        filePath={section.path}
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
    ),
    [
      addLineCommentLabel,
      addLineCommentPlaceholder,
      comments,
      fileDiff,
      handleDeleteComment,
      handleAddComment,
      handleEditChange,
      handlePostRender,
      handleSubmitComment,
      handleUpdateComment,
      hasLineCommentAction,
      isEditable,
      pendingComment,
      section.path,
      settings,
      sideBySide,
      worktreeId
    ]
  )

  return (
    <div className="border-b border-border">
      <DiffSectionHeader
        path={section.path}
        dirty={section.dirty}
        collapsed={section.collapsed}
        added={lineStats?.added ?? section.added ?? 0}
        removed={lineStats?.removed ?? section.removed ?? 0}
        onToggle={() => toggleSection(index)}
        onOpenSection={(event) => {
          event.stopPropagation()
          openSection(index)
        }}
        openSectionTitle={openSectionTitle}
        onOpenPreview={
          onOpenPreview
            ? () => {
                onOpenPreview(section, index)
              }
            : undefined
        }
        trailingContent={renderHeaderTrailingContent?.(section, index)}
      />

      {!section.collapsed && (
        <DiffSectionBody
          section={section}
          index={index}
          sectionBodyRef={sectionBodyRef}
          sectionBodyHeight={sectionBodyHeight}
          useIntrinsicImageHeight={useIntrinsicImageHeight}
          isBranchMode={isBranchMode}
          sideBySide={sideBySide}
          isEditable={isEditable}
          renderDiff={renderDiff}
          onRetrySection={retrySection}
          onLoadDeferredSection={loadDeferredSection ?? loadSection}
          onSaveLimitedDiff={() => void handleSectionSaveRef.current(index)}
        />
      )}
    </div>
  )
}
