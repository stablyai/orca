import React, { type Dispatch, type SetStateAction } from 'react'
import { Plus } from 'lucide-react'
import { DiffCommentPopover } from '../../../diff-comments/DiffCommentPopover'
import { useTranslate } from '@/i18n/use-translate'
import type { MonacoMarkdownSelectionAnnotationTarget } from './monaco-markdown-selection-annotation'
import type { MarkdownCommentPopoverState } from './use-monaco-markdown-annotations'

type MonacoMarkdownAnnotationOverlayProps = {
  shouldShowMarkdownAnnotations: boolean
  commentPopover: MarkdownCommentPopoverState | null
  setCommentPopover: Dispatch<SetStateAction<MarkdownCommentPopoverState | null>>
  selectionAnnotationTarget: MonacoMarkdownSelectionAnnotationTarget | null
  setSelectionAnnotationTarget: Dispatch<
    SetStateAction<MonacoMarkdownSelectionAnnotationTarget | null>
  >
  onSubmitMarkdownComment: (body: string) => Promise<void>
}

export function MonacoMarkdownAnnotationOverlay({
  shouldShowMarkdownAnnotations,
  commentPopover,
  setCommentPopover,
  selectionAnnotationTarget,
  setSelectionAnnotationTarget,
  onSubmitMarkdownComment
}: MonacoMarkdownAnnotationOverlayProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      {commentPopover && shouldShowMarkdownAnnotations && (
        <DiffCommentPopover
          key={`${commentPopover.startLine ?? commentPopover.lineNumber}:${commentPopover.lineNumber}`}
          lineNumber={commentPopover.lineNumber}
          startLine={commentPopover.startLine}
          top={commentPopover.top}
          left={commentPopover.left}
          onCancel={() => setCommentPopover(null)}
          onSubmit={onSubmitMarkdownComment}
        />
      )}
      {selectionAnnotationTarget && shouldShowMarkdownAnnotations && !commentPopover ? (
        <button
          type="button"
          className="orca-diff-comment-add-btn"
          style={{
            display: 'flex',
            top: Math.max(4, selectionAnnotationTarget.top - 22),
            left: selectionAnnotationTarget.left ?? 4
          }}
          title={t('auto.components.editor.MonacoEditor.68cb83f4a7', 'Add note on selected text')}
          aria-label={t(
            'auto.components.editor.MonacoEditor.68cb83f4a7',
            'Add note on selected text'
          )}
          onMouseDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            setCommentPopover(selectionAnnotationTarget)
            setSelectionAnnotationTarget(null)
          }}
        >
          <Plus className="size-3" />
        </button>
      ) : null}
    </>
  )
}
