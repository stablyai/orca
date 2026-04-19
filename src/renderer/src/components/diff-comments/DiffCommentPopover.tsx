import { useEffect, useId, useRef, useState } from 'react'
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
  onSubmit: (body: string) => Promise<void>
}

export function DiffCommentPopover({
  lineNumber,
  top,
  onCancel,
  onSubmit
}: Props): React.JSX.Element {
  const [body, setBody] = useState('')
  // Why: `submitting` prevents duplicate comment rows when the user
  // double-clicks the Comment button or hits Cmd/Ctrl+Enter twice before the
  // IPC round-trip resolves. Iteration 1 made submission async and keeps the
  // popover open on failure (to preserve the draft); that widened the window
  // between the first click and `setPopover(null)` during which a second
  // trigger would call `addDiffComment` again and produce a second row with a
  // fresh id/createdAt. Tracked in React state (not a ref) so the button can
  // reflect the in-flight status to the user.
  const [submitting, setSubmitting] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  // Why: stable id per-instance so multiple popovers (should they ever coexist)
  // don't collide on aria-labelledby references. Screen readers announce the
  // "Line N" label as the dialog's accessible name.
  const labelId = useId()

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

  const handleSubmit = async (): Promise<void> => {
    if (submitting) {
      return
    }
    const trimmed = body.trim()
    if (!trimmed) {
      return
    }
    setSubmitting(true)
    try {
      await onSubmit(trimmed)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      ref={popoverRef}
      className="orca-diff-comment-popover"
      style={{ top: `${top}px` }}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelId}
      onMouseDown={(ev) => ev.stopPropagation()}
      onClick={(ev) => ev.stopPropagation()}
    >
      <div id={labelId} className="orca-diff-comment-popover-label">
        Line {lineNumber}
      </div>
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
            // Why: guard against a second Cmd/Ctrl+Enter while an earlier
            // submit is still awaiting IPC — otherwise it would enqueue a
            // duplicate addDiffComment call.
            if (submitting) {
              return
            }
            void handleSubmit()
          }
        }}
        rows={3}
      />
      <div className="orca-diff-comment-popover-footer">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={handleSubmit} disabled={submitting || body.trim().length === 0}>
          {submitting ? 'Saving…' : 'Comment'}
        </Button>
      </div>
    </div>
  )
}
