import { Trash } from 'lucide-react'

// Why: the saved-comment card lives inside a Monaco view zone's DOM node.
// useDiffCommentDecorator creates a React root per zone and renders this
// component into it so we can use normal lucide icons and JSX instead of
// hand-built DOM + inline SVG strings.

type Props = {
  lineNumber: number
  body: string
  onDelete: () => void
}

export function DiffCommentCard({ lineNumber, body, onDelete }: Props): React.JSX.Element {
  return (
    <div className="orca-diff-comment-card">
      <div className="orca-diff-comment-header">
        <span className="orca-diff-comment-meta">Comment · line {lineNumber}</span>
        <button
          type="button"
          className="orca-diff-comment-delete"
          title="Delete comment"
          aria-label="Delete comment"
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
