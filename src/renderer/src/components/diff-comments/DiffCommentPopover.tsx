import { ImeTextarea } from '@/lib/text-input/ime/ime-text-field'
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { CornerDownLeft } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import {
  getCommentBodySubmitState,
  hasBoundedCommentBodyText
} from '@/lib/source-control/review/comments/comment-body-submit-state'
import { useTranslate } from '@/i18n/use-translate'
import { installOpenDraftAddReviewNoteGuard } from '../editor/commands/editor-shortcuts'
import { resolveDiffCommentPopoverTop } from './diff-comment-popover-position'

// Why: a DOM sibling overlay rather than a Monaco content widget, so it can own a React auto-resizing textarea.

type Props = {
  lineNumber: number
  startLine?: number
  /** Overlay coordinates. Omitted when the popover renders inline in a diff annotation row. */
  top?: number
  left?: number
  /** `inline` drops absolute positioning so a Pierre annotation row can own the layout. */
  layout?: 'overlay' | 'inline'
  // Anchor line height, used to flip the popover above the line near the viewport bottom; 0 for non-Monaco callers.
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
  layout = 'overlay',
  lineHeight = 0,
  title,
  placeholder: placeholderOverride,
  submitLabel: submitLabelOverride,
  submittingLabel: submittingLabelOverride,
  onCancel,
  onSubmit
}: Props): React.JSX.Element {
  const t = useTranslate()
  const placeholder =
    placeholderOverride ??
    t('auto.components.diff.comments.DiffCommentPopover.f6c449191e', 'Add note for the AI')
  const submitLabel =
    submitLabelOverride ??
    t('auto.components.diff.comments.DiffCommentPopover.5fa4bfebaa', 'Add note')
  const submittingLabel =
    submittingLabelOverride ??
    t('auto.components.diff.comments.DiffCommentCard.bb0a55f856', 'Saving…')
  const [body, setBody] = useState('')
  // Why: mirror the draft into a ref so the mousedown listener reads it fresh without re-registering each keystroke.
  const bodyRef = useRef(body)
  bodyRef.current = body
  // Why: block duplicate note rows from double-click/Enter during the async submit; state (not a ref) so the button shows in-flight.
  const [submitting, setSubmitting] = useState(false)
  const mountedRef = useMountedRef()
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  // Why: keep onCancel in a ref so the mousedown listener reads it fresh without re-attaching when parents pass a new callback each render.
  const onCancelRef = useRef(onCancel)
  onCancelRef.current = onCancel
  const labelId = useId()
  // Why: seed at `top` for a correct first paint when there's room below; the layout effect flips it above the line if clipped.
  const [resolvedTop, setResolvedTop] = useState(top ?? 0)

  // Why: mirror `top` into a ref so the measure callback stays stable and the ResizeObserver isn't re-mounted each scroll frame.
  const topRef = useRef(top ?? 0)
  const lineHeightRef = useRef(lineHeight)
  const layoutRef = useRef(layout)
  useLayoutEffect(() => {
    topRef.current = top ?? 0
    lineHeightRef.current = lineHeight
    layoutRef.current = layout
  }, [top, lineHeight, layout])

  const measureResolvedTop = useCallback((): void => {
    if (layoutRef.current === 'inline') {
      return
    }
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

  // Why: re-resolve placement before paint when the anchor moves (scroll, font zoom) so flip/clamp tracks without flicker.
  useLayoutEffect(() => {
    measureResolvedTop()
  }, [top, lineHeight, measureResolvedTop])

  // Why: observe textarea auto-grow and pane resize so a growing draft re-resolves and never clips at the bottom.
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
    textareaRef.current = textarea
    textarea?.focus()
  }, [])

  useEffect(() => {
    // Pierre assigns the annotation slot after React attaches this textarea.
    const frame = requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [])

  // Why: consume the add-review-note chord on the popover subtree, not window, so a repeat chord doesn't remount the draft.
  useEffect(() => {
    const popover = popoverRef.current
    if (!popover) {
      return
    }
    return installOpenDraftAddReviewNoteGuard(popover)
  }, [])

  // Why: Monaco's editor doesn't bubble React clicks up, so detect outside-clicks with a document-level mousedown listener.
  useEffect(() => {
    const onDocumentMouseDown = (ev: MouseEvent): void => {
      if (!popoverRef.current) {
        return
      }
      if (popoverRef.current.contains(ev.target as Node)) {
        return
      }
      // Why: soft dismiss — keep any non-whitespace draft even when submit's bounded scanner would reject it as too large.
      if (hasDraftText(bodyRef.current)) {
        return
      }
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
        t(
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
      className={
        layout === 'inline'
          ? 'orca-diff-comment-popover orca-diff-comment-popover-inline'
          : 'orca-diff-comment-popover'
      }
      style={
        layout === 'inline'
          ? undefined
          : { top: `${resolvedTop}px`, ...(left == null ? {} : { left: `${left}px` }) }
      }
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
              ? t(
                  'auto.components.diff.comments.DiffCommentPopover.c845170b3b',
                  'Lines {{value0}}-{{value1}}',
                  { value0: startLine, value1: lineNumber }
                )
              : t(
                  'auto.components.diff.comments.DiffCommentPopover.e05063cfc1',
                  'Line {{value0}}',
                  { value0: lineNumber }
                ))}
        </div>
        <ImeTextarea
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
            // Why: Shift+Enter inserts a newline; skip isComposing so IME composition Enter doesn't submit a half-typed CJK note.
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
            {t('auto.components.diff.comments.DiffCommentPopover.2b3ce6d394', 'Cancel')}
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
