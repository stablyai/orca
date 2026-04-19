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
  const popoverRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  // Why: Monaco's editor area does not bubble a synthetic React click up to
  // the popover's onClick. Without a document-level mousedown listener, the
  // popover has no way to detect clicks outside its own bounds. We keep the
  // `onMouseDown={ev.stopPropagation()}` on the popover root so that this
  // listener sees outside-clicks only.
  useEffect(() => {
    const onDocumentMouseDown = (ev: MouseEvent): void => {
      if (!popoverRef.current) {
        return
      }
      if (popoverRef.current.contains(ev.target as Node)) {
        return
      }
      onCancel()
    }
    document.addEventListener('mousedown', onDocumentMouseDown)
    return () => {
      document.removeEventListener('mousedown', onDocumentMouseDown)
    }
  }, [onCancel])

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
      ref={popoverRef}
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
