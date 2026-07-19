import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { CornerDownLeft } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import {
  getCommentBodySubmitState,
  hasBoundedCommentBodyText
} from '@/lib/comment-body-submit-state'
import { translate } from '@/i18n/i18n'
import { installOpenDraftAddReviewNoteGuard } from '../editor/editor-shortcuts'
import { resolveDiffCommentPopoverTop } from './diff-comment-popover-position'

// Why: rendered as a DOM sibling overlay inside the editor container rather
// than as a Monaco content widget because it owns a React textarea with
// auto-resize behaviour. Positioning mirrors what useDiffCommentDecorator does
// for the "+" button so scroll updates from the parent keep the popover
// aligned with its anchor line.

type Props = {
  lineNumber: number
  startLine?: number
  top: number
  left?: number
  // Height of the anchor line, used to flip the popover above it when it would
  // overflow the bottom of the viewport. Defaults to 0 for callers that don't
  // anchor to a Monaco line (e.g. markdown annotations): the popover still
  // clamps inside the viewport, it just doesn't offset by the line's height.
  lineHeight?: number
  title?: string
  placeholder?: string
  submitLabel?: string
  submittingLabel?: string
  onCancel: () => void
  onSubmit: (body: string) => Promise<void>
}

function hasDraftText(body: string): boolean {
  return /\S/u.test(body)
}

export function DiffCommentPopover({
  lineNumber,
  startLine,
  top,
  left,
  lineHeight = 0,
  title,
  placeholder = 'Add note for the AI',
  submitLabel = 'Add note',
  submittingLabel = 'Saving…',
  onCancel,
  onSubmit
}: Props): React.JSX.Element {
  const [body, setBody] = useState('')
  // Why: mirror the draft into a ref so the document mousedown listener (empty
  // dep array, see below) can read the freshest body without re-registering on
  // every keystroke. Used to keep the popover open on outside-click when the
  // user has typed something, so an accidental click never discards a draft.
  const bodyRef = useRef(body)
  bodyRef.current = body
  // Why: `submitting` prevents duplicate note rows when the user
  // double-clicks the Add note button or hits Enter twice before the
  // IPC round-trip resolves. Iteration 1 made submission async and keeps the
  // popover open on failure (to preserve the draft); that widened the window
  // between the first click and `setPopover(null)` during which a second
  // trigger would call `addDiffComment` again and produce a second row with a
  // fresh id/createdAt. Tracked in React state (not a ref) so the button can
  // reflect the in-flight status to the user.
  const [submitting, setSubmitting] = useState(false)
  const mountedRef = useMountedRef()
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
  // Why: `top` anchors the popover just below the selected line. Near the
  // bottom of the editor viewport that downward box gets clipped by the pane's
  // overflow container, so the resolved top may flip the popover above the line
  // (see resolveDiffCommentPopoverTop). Start at `top` so the first paint is
  // correct when there is room below; the layout effect refines it otherwise.
  const [resolvedTop, setResolvedTop] = useState(top)

  // Why: read the freshest anchor inside `measure` (a stable callback) so the
  // ResizeObserver below can stay mounted once instead of tearing down on every
  // scroll frame, which updates `top` continuously while the popover is open.
  const topRef = useRef(top)
  topRef.current = top
  const lineHeightRef = useRef(lineHeight)
  lineHeightRef.current = lineHeight

  const measureResolvedTop = useCallback((): void => {
    const popover = popoverRef.current
    const container = popover?.parentElement
    if (!popover || !container) {
      setResolvedTop(topRef.current)
      return
    }
    setResolvedTop(
      resolveDiffCommentPopoverTop({
        belowTop: topRef.current,
        lineHeight: lineHeightRef.current,
        popoverHeight: popover.offsetHeight,
        viewportHeight: container.clientHeight
      })
    )
  }, [])

  // Why: re-resolve placement before paint whenever the anchor moves (scroll,
  // font zoom) so the flip/clamp tracks the selected line without flicker.
  useLayoutEffect(() => {
    measureResolvedTop()
  }, [top, lineHeight, measureResolvedTop])

  // Why: the textarea auto-grows as the user types and the editor pane can be
  // resized; observe both so a growing draft re-resolves and never ends up
  // clipped at the bottom edge.
  useEffect(() => {
    const popover = popoverRef.current
    const container = popover?.parentElement
    if (!popover || !container || typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(() => measureResolvedTop())
    observer.observe(popover)
    observer.observe(container)
    return () => observer.disconnect()
  }, [measureResolvedTop])

  const focusTextareaRef = useCallback((textarea: HTMLTextAreaElement | null): void => {
    // Why: the draft field should receive focus as soon as the popover mounts;
    // no external system needs a post-render Effect for this.
    textarea?.focus()
  }, [])

  // Why: product B — the composer autofocuses its textarea, so a second
  // add-review-note chord must not remount the draft; consume it on the
  // popover subtree (not window) so other panes/surfaces keep their chord.
  useEffect(() => {
    const popover = popoverRef.current
    if (!popover) {
      return
    }
    return installOpenDraftAddReviewNoteGuard(popover)
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
      // Why: outside-click is a soft dismiss, so preserve any non-whitespace
      // draft even when submit's bounded scanner would reject it as too large.
      if (hasDraftText(bodyRef.current)) {
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
    const bodyState = getCommentBodySubmitState(body)
    if (bodyState.status === 'empty') {
      return
    }
    if (bodyState.status === 'too-large-leading-whitespace') {
      toast.error(
        translate(
          'auto.components.diff.comments.DiffCommentPopover.commentTooLarge',
          'Comment is too large to submit safely.'
        )
      )
      return
    }
    setSubmitting(true)
    try {
      await onSubmit(bodyState.body)
    } finally {
      if (mountedRef.current) {
        setSubmitting(false)
      }
    }
  }
  const canSubmitComment = hasBoundedCommentBodyText(body)

  return (
    <div
      ref={popoverRef}
      className="orca-diff-comment-popover"
      style={{ top: `${resolvedTop}px`, ...(left == null ? {} : { left: `${left}px` }) }}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelId}
      onMouseDown={(ev) => ev.stopPropagation()}
      onClick={(ev) => ev.stopPropagation()}
    >
      {/* Content */}
      <div className="orca-diff-comment-content-col" style={{ gap: '8px' }}>
        <div id={labelId} className="orca-diff-comment-popover-label">
          {title ??
            (startLine && startLine !== lineNumber
              ? translate(
                  'auto.components.diff.comments.DiffCommentPopover.c845170b3b',
                  'Lines {{value0}}-{{value1}}',
                  { value0: startLine, value1: lineNumber }
                )
              : translate(
                  'auto.components.diff.comments.DiffCommentPopover.e05063cfc1',
                  'Line {{value0}}',
                  { value0: lineNumber }
                ))}
        </div>
        <textarea
          ref={focusTextareaRef}
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
            {translate('auto.components.diff.comments.DiffCommentPopover.2b3ce6d394', 'Cancel')}
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={submitting || !canSubmitComment}>
            {submitting ? submittingLabel : submitLabel}
            {!submitting && <CornerDownLeft className="ml-1 size-3 opacity-70" />}
          </Button>
        </div>
      </div>
    </div>
  )
}
