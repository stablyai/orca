import { useCallback, useMemo, useRef } from 'react'
import { FileDiff } from '@pierre/diffs/react'
import type { FileDiffMetadata, PostRenderPhase, SelectedLineRange } from '@pierre/diffs'
import type { FileContents } from '@pierre/diffs'
import type { EditorOptions } from '@pierre/diffs/edit'
import { useAppStore } from '@/store'
import { RecoverableRenderErrorBoundary } from '@/components/error-boundaries/RecoverableRenderErrorBoundary'
import type { DecoratedDiffComment } from '../../diff-comments/decorated-diff-comment'
import { buildPierreDiffOptions, buildPierreDiffStyle } from './pierre-diff-options'
import type { PierreDiffSettings } from './pierre-diff-options'
import {
  buildPierreDiffCommentAnnotations,
  renderPierreDiffCommentAnnotation,
  type PierreDiffAnnotationData,
  type PierreDiffCommentAnnotation
} from './pierre-diff-comment-annotations'
import { usePierreDiffFind } from './use-pierre-diff-find'

export type PierreDiffSurfaceProps = {
  fileDiff: FileDiffMetadata
  sideBySide: boolean
  settings?: PierreDiffSettings | null
  isEditable: boolean
  /** Collapse unchanged context. Combined diffs do; the single-file tab does not. */
  collapseUnchanged: boolean
  worktreeId: string
  filePath: string
  comments: readonly DecoratedDiffComment[]
  formatCommentPrompt?: (comment: DecoratedDiffComment) => string
  onDeleteComment: (commentId: string) => void
  onUpdateComment?: (commentId: string, body: string) => Promise<boolean>
  /** Live document stream while an edit session is active. */
  onEditChange?: (file: FileContents) => void
  /** Fires on Pierre's DOM lifecycle; used for height measurement. */
  onPostRender?: (node: HTMLElement, phase: PostRenderPhase) => void
  /** Gutter affordance for starting a note; omit to hide it. */
  onAddComment?: (range: { lineNumber: number; startLine?: number }) => void
  /** Open note draft, rendered inline on its anchor line. */
  pendingComment?: { lineNumber: number; startLine?: number } | null
  addCommentPlaceholder?: string
  addCommentLabel?: string
  onCancelComment?: () => void
  onSubmitComment?: (body: string) => Promise<void>
  className?: string
}

/**
 * The single diff renderer behind every Orca diff surface. Replaces the Monaco
 * `DiffEditor` that used to mount once per visible file.
 */
export function PierreDiffSurface({
  fileDiff,
  sideBySide,
  settings,
  isEditable,
  collapseUnchanged,
  worktreeId,
  filePath,
  comments,
  formatCommentPrompt,
  onDeleteComment,
  onUpdateComment,
  onEditChange,
  onPostRender,
  onAddComment,
  pendingComment,
  addCommentPlaceholder,
  addCommentLabel,
  onCancelComment,
  onSubmitComment,
  className
}: PierreDiffSurfaceProps): React.JSX.Element {
  const editorFontZoomLevel = useAppStore((s) => s.editorFontZoomLevel)
  const clearDeliveredDiffComments = useAppStore((s) => s.clearDeliveredDiffComments)
  const activeGroupId = useAppStore((s) =>
    worktreeId ? (s.activeGroupIdByWorktree[worktreeId] ?? worktreeId) : worktreeId
  )
  const containerRef = useRef<HTMLDivElement | null>(null)
  const { editEnabled, handleContainerKeyDown, handleContainerBlur, handleEditorAttach } =
    usePierreDiffFind({ isEditable, containerRef })

  const options = useMemo(
    () => ({
      ...buildPierreDiffOptions<PierreDiffAnnotationData>({
        settings,
        sideBySide,
        collapseUnchanged
      }),
      enableGutterUtility: Boolean(onAddComment),
      onGutterUtilityClick: onAddComment
        ? (range: SelectedLineRange) =>
            onAddComment({
              lineNumber: Math.max(range.start, range.end),
              startLine: range.start === range.end ? undefined : Math.min(range.start, range.end)
            })
        : undefined,
      onPostRender: onPostRender
        ? (node: HTMLElement, _instance: unknown, phase: PostRenderPhase) =>
            onPostRender(node, phase)
        : undefined
    }),
    [settings, sideBySide, collapseUnchanged, onPostRender, onAddComment]
  )
  const style = useMemo(
    () => buildPierreDiffStyle(settings, editorFontZoomLevel),
    [settings, editorFontZoomLevel]
  )
  const lineAnnotations = useMemo(
    () => buildPierreDiffCommentAnnotations(comments, pendingComment),
    [comments, pendingComment]
  )
  const editorOptions = useMemo<EditorOptions<'file-diff', PierreDiffAnnotationData, undefined>>(
    () => ({
      onAttach: handleEditorAttach,
      // Why: Cmd+F opens edit mode even on read-only diffs, so ignore changes
      // unless this surface can actually save. Otherwise a stray keystroke in
      // the find panel marks a staged or branch section dirty with no save path.
      onChange: (event) => {
        if (isEditable) {
          onEditChange?.(event.file)
        }
      }
    }),
    [handleEditorAttach, isEditable, onEditChange]
  )
  const renderAnnotation = useCallback(
    (annotation: PierreDiffCommentAnnotation) =>
      renderPierreDiffCommentAnnotation(annotation, {
        worktreeId,
        filePath,
        activeGroupId,
        formatCommentPrompt,
        onDeleteComment,
        onUpdateComment,
        clearDeliveredDiffComments,
        draftPlaceholder: addCommentPlaceholder,
        draftSubmitLabel: addCommentLabel,
        onCancelDraft: onCancelComment,
        onSubmitDraft: onSubmitComment
      }),
    [
      worktreeId,
      filePath,
      activeGroupId,
      formatCommentPrompt,
      onDeleteComment,
      onUpdateComment,
      clearDeliveredDiffComments,
      addCommentPlaceholder,
      addCommentLabel,
      onCancelComment,
      onSubmitComment
    ]
  )

  return (
    // Why: ⌘F must be caught before Pierre mounts an editor, so the listener lives on the host.
    <div
      className={className}
      onKeyDownCapture={handleContainerKeyDown}
      onBlur={handleContainerBlur}
    >
      {/* Why: @pierre/diffs throws from its own ref teardown on some remounts
          ("A FileDiff instance should exist when unmounting"). Contain it to the
          one file instead of letting an experimental dependency take down the
          whole terminal workbench. */}
      <RecoverableRenderErrorBoundary
        boundaryId="editor.pierre-diff-surface"
        surface="page"
        compact
        resetKey={fileDiff.name}
        title="This diff could not be rendered"
        description="Reopen the file or reload to try again."
      >
        <FileDiff<PierreDiffAnnotationData>
          fileDiff={fileDiff}
          options={options}
          style={style}
          edit={editEnabled}
          editorOptions={editorOptions}
          lineAnnotations={lineAnnotations}
          renderAnnotation={renderAnnotation}
          />
      </RecoverableRenderErrorBoundary>
    </div>
  )
}
