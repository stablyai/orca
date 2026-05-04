import { useEffect, useId, useRef, useState } from 'react'
import { CornerDownLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'

// Why: rendered as a DOM sibling overlay inside the editor container rather
// than as a Monaco content widget because it owns a React textarea with
// auto-resize behaviour. Positioning mirrors what useDiffCommentDecorator does
// for the "+" button so scroll updates from the parent keep the popover
// aligned with its anchor line.

type Props = {
  lineNumber: number
  startLine?: number
  top: number
  title?: string
  placeholder?: string
  submitLabel?: string
  submittingLabel?: string
  onCancel: () => void
  onSubmit: (body: string) => Promise<void>
}

export function DiffCommentPopover({
  lineNumber,
  startLine,
  top,
  title,
  placeholder = 'Add note for the AI',
  submitLabel = 'Add note',
  submittingLabel = 'Saving…',
  onCancel,
  onSubmit
}: Props): React.JSX.Element {
  const [body, setBody] = useState('')
  // Why: `submitting` prevents duplicate note rows when the user
  // double-clicks the Add note button or hits Enter twice before the
  // IPC round-trip resolves. Iteration 1 made submission async and keeps the
  // popover open on failure (to preserve the draft); that widened the window
  // between the first click and `setPopover(null)` during which a second
  // trigger would call `addDiffComment` again and produce a second row with a
  // fresh id/createdAt. Tracked in React state (not a ref) so the button can
  // reflect the in-flight status to the user.
  const [submitting, setSubmitting] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  // Why: stash onCancel in a ref so the document mousedown listener below can
  // read the freshest callback without listing `onCancel` in its dependency
  // array. Parents (DiffSectionItem, DiffViewer) pass a new arrow function on
  // every render and the popover re-renders frequently (scroll tracking updates
  // `top`, font zoom, etc.), which would otherwise tear down and re-attach the
  // document listener on every parent render. Mirrors the pattern in
  // useDiffCommentDecorator.tsx.
  const onCancelRef = useRef(onCancel)
  onCancelRef.current = onCancel
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
      // Why: read the latest onCancel from the ref rather than closing over it
      // so the listener does not need to be re-registered on every parent
      // render (see onCancelRef comment above).
      onCancelRef.current()
    }
    document.addEventListener('mousedown', onDocumentMouseDown)
    return () => {
      document.removeEventListener('mousedown', onDocumentMouseDown)
    }
  }, [])

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
        {title ??
          (startLine && startLine !== lineNumber
            ? `Lines ${startLine}-${lineNumber}`
            : `Line ${lineNumber}`)}
      </div>
      <textarea
        ref={textareaRef}
        className="orca-diff-comment-popover-textarea"
        placeholder={placeholder}
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
          // Why: plain Enter submits so the note popover behaves like a
          // single-field form. Shift+Enter inserts a newline (browser default)
          // so multi-line notes are still possible. We also accept
          // Cmd/Ctrl+Enter as a submit alias so users who learned the old
          // shortcut aren't silently broken. IME composition (isComposing) is
          // excluded because Enter during composition only confirms the
          // conversion candidate — submitting then would send a half-typed
          // note for CJK/IME users. We guard against a second Enter while an
          // earlier submit is still awaiting IPC — otherwise it would enqueue
          // a duplicate addDiffComment call.
          if (e.key === 'Enter' && !e.nativeEvent.isComposing && !e.shiftKey) {
            e.preventDefault()
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
          {submitting ? submittingLabel : submitLabel}
          {!submitting && <CornerDownLeft className="ml-1 size-3 opacity-70" />}
        </Button>
      </div>
    </div>
  )
}
