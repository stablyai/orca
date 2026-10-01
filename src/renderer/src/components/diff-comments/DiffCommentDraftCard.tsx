import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { CornerDownLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import {
  getCommentBodySubmitState,
  hasBoundedCommentBodyText
} from '@/lib/comment-body-submit-state'
import { toast } from 'sonner'
import { installOpenDraftAddReviewNoteGuard } from '../editor/editor-shortcuts'

export type DiffCommentDraftCardProps = {
  lineNumber: number
  startLine?: number
  placeholder?: string
  submitLabel?: string
  submittingLabel?: string
  initialBody?: string
  onBodyChange?: (body: string) => void
  onCancel: () => void
  onSubmit: (body: string) => Promise<boolean>
  onContentResize?: () => void
}

function resizeDraftTextarea(textarea: HTMLTextAreaElement): boolean {
  const previousHeight = textarea.style.height
  textarea.style.height = 'auto'
  textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 60), 240)}px`
  return textarea.style.height !== previousHeight
}

export function DiffCommentDraftCard({
  lineNumber,
  startLine,
  placeholder,
  submitLabel,
  submittingLabel,
  onCancel,
  onSubmit,
  onContentResize,
  initialBody = '',
  onBodyChange
}: DiffCommentDraftCardProps): React.JSX.Element {
  const [body, setBody] = useState(initialBody)
  const bodyRef = useRef(body)
  const [submitting, setSubmitting] = useState(false)
  const mountedRef = useMountedRef()
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const onContentResizeRef = useRef(onContentResize)

  useEffect(() => {
    bodyRef.current = body
  }, [body])

  useEffect(() => {
    onContentResizeRef.current = onContentResize
  }, [onContentResize])

  const labelId = useId()
  const headerLabel =
    startLine && startLine !== lineNumber
      ? translate(
          'auto.components.diff.comments.DiffCommentPopover.c845170b3b',
          'Lines {{value0}}-{{value1}}',
          { value0: startLine, value1: lineNumber }
        )
      : translate(
          'auto.components.diff.comments.DiffCommentPopover.e05063cfc1',
          'Line {{value0}}',
          { value0: lineNumber }
        )

  const focusTextareaRef = useCallback((textarea: HTMLTextAreaElement | null): void => {
    textareaRef.current = textarea
    textarea?.focus()
  }, [])

  useEffect(() => {
    const focusTextarea = (): void => textareaRef.current?.focus()
    focusTextarea()
    if (typeof requestAnimationFrame !== 'function') {
      return
    }
    const frame = requestAnimationFrame(focusTextarea)
    return () => cancelAnimationFrame(frame)
  }, [])

  useLayoutEffect(() => {
    const card = cardRef.current
    if (!card || !onContentResizeRef.current) {
      return
    }
    const textarea = textareaRef.current
    if (textarea) {
      resizeDraftTextarea(textarea)
    }
    onContentResizeRef.current()
    if (typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(() => {
      onContentResizeRef.current?.()
    })
    observer.observe(card)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const card = cardRef.current
    if (!card) {
      return
    }
    return installOpenDraftAddReviewNoteGuard(card)
  }, [])

  useEffect(() => {
    const onDocumentMouseDown = (event: MouseEvent): void => {
      const card = cardRef.current
      const target = event.target
      if (!card || (target instanceof Node && card.contains(target))) {
        return
      }
      // Keep a non-empty draft alive when the user clicks another line's add button.
      if (/\S/u.test(bodyRef.current)) {
        return
      }
      onCancel()
    }
    document.addEventListener('mousedown', onDocumentMouseDown)
    return () => document.removeEventListener('mousedown', onDocumentMouseDown)
  }, [onCancel])

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
    // Chromium drops focus to <body> when the pressed button turns disabled, and the zone only
    // hands focus back to Monaco while the card still holds it. Park it on the textarea first.
    textareaRef.current?.focus()
    setSubmitting(true)
    try {
      const result = await onSubmit(bodyState.body)
      if (result === false && mountedRef.current) {
        setSubmitting(false)
      }
    } catch (err) {
      console.error('Failed to submit diff comment draft:', err)
      // A rejected save never reaches the caller's own failure toast, so report it here.
      toast.error(
        translate('auto.components.editor.diffCommentSaveFailed', 'Failed to save comment')
      )
      if (mountedRef.current) {
        setSubmitting(false)
      }
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    e.stopPropagation()

    if (e.key === 'Escape') {
      e.preventDefault()
      if (submitting) {
        return
      }
      onCancel()
      return
    }

    const isEnter = e.key === 'Enter' && !e.nativeEvent.isComposing
    const isCmdOrCtrl = e.metaKey || e.ctrlKey
    // Plain Shift+Enter inserts a newline; Cmd/Ctrl+Enter submits even with Shift.
    if (isEnter && (isCmdOrCtrl || !e.shiftKey)) {
      e.preventDefault()
      if (submitting) {
        return
      }
      void handleSubmit()
    }
  }

  const canSubmit = !submitting && hasBoundedCommentBodyText(body)

  return (
    <div
      ref={cardRef}
      className="orca-diff-comment-popover orca-diff-comment-draft-card"
      role="region"
      aria-labelledby={labelId}
      onMouseDown={(ev) => ev.stopPropagation()}
      onClick={(ev) => ev.stopPropagation()}
    >
      <div className="orca-diff-comment-content-col gap-2">
        <div id={labelId} className="orca-diff-comment-popover-label">
          {headerLabel}
        </div>

        {/* Textarea */}
        <textarea
          ref={focusTextareaRef}
          className="orca-diff-comment-popover-textarea"
          placeholder={
            placeholder ??
            translate(
              'auto.components.diff.comments.DiffCommentPopover.f6c449191e',
              'Add note for the AI'
            )
          }
          value={body}
          rows={3}
          onChange={(e) => {
            setBody(e.target.value)
            onBodyChange?.(e.target.value)
            if (resizeDraftTextarea(e.currentTarget)) {
              onContentResizeRef.current?.()
            }
          }}
          onKeyDown={handleKeyDown}
        />

        {/* Footer */}
        <div className="orca-diff-comment-popover-footer">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>
            {translate('auto.components.diff.comments.DiffCommentPopover.2b3ce6d394', 'Cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            aria-label={
              submitLabel ??
              translate('auto.components.diff.comments.DiffCommentPopover.5fa4bfebaa', 'Add note')
            }
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
          >
            {submitting
              ? (submittingLabel ??
                translate(
                  'auto.components.diff.comments.DiffCommentPopover.5e9b3d0c2e',
                  'Adding...'
                ))
              : (submitLabel ??
                translate(
                  'auto.components.diff.comments.DiffCommentPopover.5fa4bfebaa',
                  'Add note'
                ))}
            {!submitting && <CornerDownLeft className="ml-1 size-3 opacity-70" />}
          </Button>
        </div>
      </div>
    </div>
  )
}
