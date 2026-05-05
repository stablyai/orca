import { Trash } from 'lucide-react'

// Why: the saved-note card lives inside a Monaco view zone's DOM node.
// useDiffCommentDecorator creates a React root per zone and renders this
// component into it so we can use normal lucide icons and JSX instead of
// hand-built DOM + inline SVG strings.
//
// User-facing copy uses "Note" rather than "Comment" so it is not confused
// with GitHub PR review comments (which some diff-view surfaces also render).
// Internal types/ids (`DiffComment`, `diffComments`, `addDiffComment`) keep
// the old names so we don't have to migrate the persisted WorktreeMeta shape.

type Props = {
  lineNumber: number
  body: string
  onDelete: () => void
}

export function DiffCommentCard({ lineNumber, body, onDelete }: Props): React.JSX.Element {
  return (
    <div className="orca-diff-comment-card">
      <div className="orca-diff-comment-header">
        <span className="orca-diff-comment-meta">Note · line {lineNumber}</span>
        <button
          type="button"
          className="orca-diff-comment-delete"
          title="Delete note"
          aria-label="Delete note"
          onMouseDown={(ev) => ev.stopPropagation()}
          onClick={(ev) => {
            ev.preventDefault()
            ev.stopPropagation()
            onDelete()
          }}
        >
          <Trash className="size-3.5" />
        </button>
      </div>
      <div className="orca-diff-comment-body">{body}</div>
    </div>
  )
}
