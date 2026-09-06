import { useCallback, useMemo } from 'react'
import { FileDiff, GutterUtilitySlotStyles } from '@pierre/diffs/react'
import type { FileDiffMetadata, PostRenderPhase, SelectedLineRange } from '@pierre/diffs'
import type { FileContents } from '@pierre/diffs'
import type { EditorOptions } from '@pierre/diffs/edit'
import { useAppStore } from '@/store'
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
  const { editEnabled, handleContainerKeyDown, handleContainerBlur, handleEditorAttach } =
    usePierreDiffFind({ isEditable })

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
  // Why: Pierre's default utility button sits 14px into the line-number column.
  // Render our own so the add-note affordance keeps the glyph-margin look and
  // hit target it had under Monaco.
  const renderGutterUtility = useCallback(
    () =>
      onAddComment ? (
        <div style={GutterUtilitySlotStyles}>
          <button
            type="button"
            className="orca-diff-comment-add-btn orca-diff-comment-add-btn-gutter"
            title={addCommentLabel}
            aria-label={addCommentLabel}
          >
            <svg
              viewBox="0 0 16 16"
              width="12"
              height="12"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M8 3v10M3 8h10" />
            </svg>
          </button>
        </div>
      ) : null,
    [addCommentLabel, onAddComment]
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
      <FileDiff<PierreDiffAnnotationData>
        fileDiff={fileDiff}
        options={options}
        style={style}
        edit={editEnabled}
        editorOptions={editorOptions}
        lineAnnotations={lineAnnotations}
        renderAnnotation={renderAnnotation}
        renderGutterUtility={renderGutterUtility}
      />
    </div>
  )
}
