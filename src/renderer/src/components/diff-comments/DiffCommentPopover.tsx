import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'

// Why: rendered as a DOM sibling overlay inside the editor container rather
// than as a Monaco content widget because it owns a React textarea with
// auto-resize behaviour. Positioning mirrors what useDiffCommentDecorator does
// for the "+" button so scroll updates from the parent keep the popover
// aligned with its anchor line.

type Props = {
  lineNumber: number
  top: number
  onCancel: () => void
  onSubmit: (body: string) => void
}

export function DiffCommentPopover({
  lineNumber,
  top,
  onCancel,
  onSubmit
}: Props): React.JSX.Element {
  const [body, setBody] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const autoResize = (el: HTMLTextAreaElement): void => {
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }

  const handleSubmit = (): void => {
    const trimmed = body.trim()
    if (!trimmed) {
      return
    }
    onSubmit(trimmed)
  }

  return (
    <div
      className="orca-diff-comment-popover"
      style={{ top: `${top}px` }}
      onMouseDown={(ev) => ev.stopPropagation()}
      onClick={(ev) => ev.stopPropagation()}
    >
      <div className="orca-diff-comment-popover-label">Line {lineNumber}</div>
      <textarea
        ref={textareaRef}
        className="orca-diff-comment-popover-textarea"
        placeholder="Add comment for the AI"
        value={body}
        onChange={(e) => {
          setBody(e.target.value)
          autoResize(e.currentTarget)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
            return
          }
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            handleSubmit()
          }
        }}
        rows={3}
      />
      <div className="orca-diff-comment-popover-footer">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={handleSubmit} disabled={body.trim().length === 0}>
          Comment
        </Button>
      </div>
    </div>
  )
}
