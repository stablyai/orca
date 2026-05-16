import { CornerDownLeft, Pencil, Trash } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { getDiffCommentLineLabel } from '@/lib/diff-comment-compat'

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
  startLine?: number
  body: string
  onDelete: () => void
  // Why: Monaco view zones have a fixed `heightInPx` set at insertion time
  // and aren't auto-measured. While the user is in edit mode the textarea
  // grows, so the parent decorator passes a callback we fire on resize and
  // it re-syncs the zone height. Without this the editor inputs would clip.
  onContentResize?: () => void
  onSubmitEdit?: (body: string) => Promise<boolean>
}

export function DiffCommentCard({
  lineNumber,
  startLine,
  body,
  onDelete,
  onContentResize,
  onSubmitEdit
}: Props): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(body)
  const [submitting, setSubmitting] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  // Why: keep the draft in sync with external body changes when not actively
  // editing, so a concurrent agent edit (or a delete + recreate) is visible
  // the next time the user opens the editor.
  useEffect(() => {
    if (!editing) {
      setDraft(body)
    }
  }, [body, editing])

  // Why: stash `onContentResize` in a ref so the layout/resize effects only
  // re-run on `editing` transitions. The decorator passes a fresh arrow every
  // render; depending on it directly would re-fire the layout effect on every
  // unrelated parent render and yank the caret to the textarea's end while
  // the user is mid-edit.
  const onContentResizeRef = useRef(onContentResize)
  onContentResizeRef.current = onContentResize

  // Why: focus + auto-grow the textarea on entering edit mode. Layout effect
  // so the height is set before the browser paints — a measurement pass on
  // the next animation frame would visibly jump from 0 to N px.
  useLayoutEffect(() => {
    if (!editing) {
      return
    }
    const el = textareaRef.current
    if (!el) {
      return
    }
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
    onContentResizeRef.current?.()
  }, [editing])

  const editingPrevRef = useRef(editing)
  useEffect(() => {
    if (editingPrevRef.current === editing) {
      return
    }
    editingPrevRef.current = editing
    // Why: when the editor opens or closes the card's height changes (textarea
    // + footer vs single body block). Ping the decorator so it re-measures and
    // resizes the Monaco view zone — otherwise the card clips the next line.
    // Skip the initial mount: the zone's heightInPx estimate is intentionally
    // close to actual on first paint to avoid a layout pass before the user
    // interacts; firing here would re-layout every card on creation.
    onContentResizeRef.current?.()
  }, [editing])

  const handleStartEdit = (): void => {
    setDraft(body)
    setEditing(true)
  }

  const handleCancel = (): void => {
    setEditing(false)
    setDraft(body)
  }

  const trimmedDraft = draft.trim()
  const canSubmit = !submitting && trimmedDraft.length > 0 && trimmedDraft !== body

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit || !onSubmitEdit) {
      return
    }
    setSubmitting(true)
    try {
      const ok = await onSubmitEdit(trimmedDraft)
      if (ok) {
        setEditing(false)
      }
    } catch (err) {
      // Why: surface the error in the console but keep the editor open with
      // the draft intact so the user can retry. Without this, a rejection from
      // `onSubmitEdit` becomes an unhandled promise rejection at the call sites
      // (`void handleSubmit()`).
      console.error('Failed to submit diff comment edit:', err)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="orca-diff-comment-card">
      <div className="orca-diff-comment-header">
        <span className="orca-diff-comment-meta">
          Note · {getDiffCommentLineLabel({ lineNumber, startLine }).toLowerCase()}
        </span>
        <div className="orca-diff-comment-actions">
          {onSubmitEdit && !editing && (
            <button
              type="button"
              className="orca-diff-comment-edit"
              title="Edit note"
              aria-label="Edit note"
              onMouseDown={(ev) => ev.stopPropagation()}
              onClick={(ev) => {
                ev.preventDefault()
                ev.stopPropagation()
                handleStartEdit()
              }}
            >
              <Pencil className="size-3.5" />
            </button>
          )}
          {!editing && (
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
          )}
        </div>
      </div>
      {editing ? (
        <>
          <textarea
            ref={textareaRef}
            className="orca-diff-comment-popover-textarea"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              const el = e.currentTarget
              el.style.height = 'auto'
              el.style.height = `${Math.min(el.scrollHeight, 240)}px`
              onContentResizeRef.current?.()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                handleCancel()
                return
              }
              // Why: plain Enter saves to mirror the new-note popover; Shift
              // +Enter keeps the newline. IME composition is excluded so a
              // CJK conversion-confirm keystroke doesn't submit a half-typed
              // note. Share the canSubmit predicate with the Save button so
              // Enter doesn't quietly close the editor when empty/unchanged
              // (the user must explicitly Cancel/Escape).
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && !e.shiftKey) {
                e.preventDefault()
                if (!canSubmit) {
                  return
                }
                void handleSubmit()
              }
            }}
            rows={3}
          />
          <div className="orca-diff-comment-popover-footer">
            <Button variant="ghost" size="sm" onClick={handleCancel} disabled={submitting}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void handleSubmit()}
              disabled={!canSubmit}
              // Why: keep the label "Save" while submitting so the button
              // doesn't change width mid-flight; the disabled state alone
              // signals the in-flight save. The title attribute surfaces the
              // status for assistive tech.
              title={submitting ? 'Saving…' : undefined}
            >
              Save
              <CornerDownLeft className="ml-1 size-3 opacity-70" />
            </Button>
          </div>
        </>
      ) : (
        <div className="orca-diff-comment-body">{body}</div>
      )}
    </div>
  )
}
