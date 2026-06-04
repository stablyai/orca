import { Plus } from 'lucide-react'
import { DiffCommentPopover } from '../diff-comments/DiffCommentPopover'
import type { RichMarkdownAnnotationTarget } from './rich-markdown-review-annotations'

type RichMarkdownAnnotationOverlayProps = {
  target: RichMarkdownAnnotationTarget | null
  popover: RichMarkdownAnnotationTarget | null
  markdownSourceLineOffset: number
  onOpenPopover: () => void
  onCancelPopover: () => void
  onSubmit: (body: string) => Promise<void>
}

export function RichMarkdownAnnotationOverlay({
  target,
  popover,
  markdownSourceLineOffset,
  onOpenPopover,
  onCancelPopover,
  onSubmit
}: RichMarkdownAnnotationOverlayProps): React.JSX.Element {
  return (
    <>
      {target ? (
        <button
          type="button"
          className="orca-diff-comment-add-btn rich-markdown-comment-add-btn"
          style={{
            top: target.buttonTop ?? 56,
            left: target.buttonLeft ?? 16
          }}
          title="Add review note"
          aria-label="Add review note"
          onMouseDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onOpenPopover()
          }}
        >
          <Plus className="size-3" />
        </button>
      ) : null}
      {popover ? (
        <DiffCommentPopover
          key={`${popover.startLine ?? popover.lineNumber}:${popover.lineNumber}`}
          lineNumber={popover.lineNumber + markdownSourceLineOffset}
          startLine={
            popover.startLine === undefined
              ? undefined
              : popover.startLine + markdownSourceLineOffset
          }
          top={popover.top}
          left={popover.left}
          title="Selected text"
          onCancel={onCancelPopover}
          onSubmit={onSubmit}
        />
      ) : null}
    </>
  )
}
