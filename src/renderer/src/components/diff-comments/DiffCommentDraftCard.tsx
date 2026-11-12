import { useGitHubTextareaImages } from '@/components/github/use-github-textarea-images'
import { useGitHubImagePending } from '@/components/github/use-github-image-uploads'
import type { GitHubImageIntake } from '@/components/github/use-github-image-uploads'
import { ImeTextarea } from '@/lib/text-input/ime/ime-text-field'
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { CornerDownLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DiffCommentComposerSession } from './diff-comment-session'
import { useLocalDiffCommentSession } from './use-local-diff-comment-session'
import { useTranslate } from '@/i18n/use-translate'
import {
  getCommentBodySubmitState,
  hasBoundedCommentBodyText
} from '@/lib/source-control/review/comments/comment-body-submit-state'
import { toast } from 'sonner'
import { installOpenDraftAddReviewNoteGuard } from '../editor/editor-shortcuts'
import {
  listenForDiffCommentZoneMouseDown,
  observeDiffCommentZoneSize,
  untilDiffCommentZoneRemoved
} from './diff-comment-zone-lifetime'

export type DiffCommentDraftCardProps = {
  lineNumber: number
  startLine?: number
  imageUploadAddress?: GitHubImageIntake['address']
  placeholder?: string
  submitLabel?: string
  submittingLabel?: string
  initialBody?: string
  onBodyChange?: (body: string) => void
  onCancel: () => void
  onSubmit: (body: string) => Promise<boolean>
  onContentResize?: () => void
  autoFocus?: boolean
  lifetime?: AbortSignal
  session?: DiffCommentComposerSession
}

function reportDraftSubmitFailure(error: unknown, message: string): void {
  console.error('Failed to submit diff comment draft:', error)
  toast.error(message)
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
  imageUploadAddress,
  placeholder,
  submitLabel,
  submittingLabel,
  onCancel,
  onSubmit,
  onContentResize,
  initialBody = '',
  onBodyChange,
  autoFocus = true,
  lifetime,
  session
}: DiffCommentDraftCardProps): React.JSX.Element {
  const t = useTranslate()
  const composer = useLocalDiffCommentSession(
    () => new DiffCommentComposerSession(initialBody),
    session
  )
  const snapshot = useSyncExternalStore(composer.subscribe, composer.getSnapshot)
  const body = snapshot.body
  const submitting = snapshot.phase === 'submitting'
  const imagePending = useGitHubImagePending()
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const images = useGitHubTextareaImages(
    textareaRef,
    body,
    (next) => {
      if (lifetime?.aborted) {
        return
      }
      composer.setBody(next)
      onBodyChange?.(next)
    },
    {
      address: imageUploadAddress,
      onPending: imagePending.onPending,
      enabled: !!imageUploadAddress && !submitting
    }
  )
  const cardRef = useRef<HTMLDivElement | null>(null)
  const onContentResizeRef = useRef(onContentResize)

  useEffect(() => {
    onContentResizeRef.current = onContentResize
  }, [onContentResize])

  const labelId = useId()
  const headerLabel =
    startLine && startLine !== lineNumber
      ? t(
          'auto.components.diff.comments.DiffCommentPopover.c845170b3b',
          'Lines {{value0}}-{{value1}}',
          { value0: startLine, value1: lineNumber }
        )
      : t('auto.components.diff.comments.DiffCommentPopover.e05063cfc1', 'Line {{value0}}', {
          value0: lineNumber
        })

  const { attachDrop } = images
  const hasImageUpload = !!imageUploadAddress
  const focusTextareaRef = useCallback(
    (textarea: HTMLTextAreaElement | null): void => {
      if (lifetime?.aborted) {
        textarea = null
      }
      if (hasImageUpload) {
        attachDrop(textarea)
      } else {
        textareaRef.current = textarea
      }
      if (autoFocus) {
        textarea?.focus()
      }
    },
    [attachDrop, autoFocus, hasImageUpload, lifetime]
  )

  useLayoutEffect(() => {
    return untilDiffCommentZoneRemoved(lifetime, () => {
      attachDrop(null)
      textareaRef.current = null
    })
  }, [attachDrop, lifetime])

  useEffect(() => {
    if (!autoFocus || lifetime?.aborted) {
      return
    }
    const focusTextarea = (): void => textareaRef.current?.focus()
    focusTextarea()
    if (typeof requestAnimationFrame !== 'function') {
      return
    }
    const frame = requestAnimationFrame(focusTextarea)
    return untilDiffCommentZoneRemoved(lifetime, () => cancelAnimationFrame(frame))
  }, [autoFocus, lifetime])

  useLayoutEffect(() => {
    const card = cardRef.current
    if (!card || lifetime?.aborted || !onContentResizeRef.current) {
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
    return observeDiffCommentZoneSize(lifetime, card, () => {
      onContentResizeRef.current?.()
    })
  }, [lifetime])

  useEffect(() => {
    const card = cardRef.current
    if (!card || lifetime?.aborted) {
      return
    }
    return untilDiffCommentZoneRemoved(lifetime, installOpenDraftAddReviewNoteGuard(card))
  }, [lifetime])

  useEffect(() => {
    if (lifetime?.aborted) {
      return
    }
    const onDocumentMouseDown = (event: MouseEvent): void => {
      const card = cardRef.current
      const target = event.target
      if (!card || (target instanceof Node && card.contains(target))) {
        return
      }
      // Keep a non-empty draft alive when the user clicks another line's add button.
      if (/\S/u.test(composer.getSnapshot().body)) {
        return
      }
      onCancel()
    }
    return listenForDiffCommentZoneMouseDown(lifetime, onDocumentMouseDown)
  }, [composer, lifetime, onCancel])

  const handleSubmit = (): void => {
    if (lifetime?.aborted || submitting || imagePending.pendingRef.current) {
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
    // Park focus before disabling the button; the zone restores Monaco focus only while its card owns focus.
    textareaRef.current?.focus(autoFocus ? undefined : { preventScroll: true })
    const message = t('auto.components.editor.diffCommentSaveFailed', 'Failed to save comment')
    const request = session ? onSubmit(bodyState.body) : composer.submit(onSubmit, bodyState.body)
    void request.catch((error) => reportDraftSubmitFailure(error, message))
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

  const canSubmit =
    !imagePending.pending && snapshot.phase === 'editing' && hasBoundedCommentBodyText(body)

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
        <ImeTextarea
          ref={focusTextareaRef}
          className="orca-diff-comment-popover-textarea"
          placeholder={
            placeholder ??
            t('auto.components.diff.comments.DiffCommentPopover.f6c449191e', 'Add note for the AI')
          }
          value={images.value}
          onPaste={images.onPaste}
          onBeforeInput={images.onBeforeInput}
          rows={3}
          onChange={(e) => {
            images.change(e.target.value)
            if (resizeDraftTextarea(e.currentTarget)) {
              onContentResizeRef.current?.()
            }
          }}
          onKeyDown={handleKeyDown}
        />

        {/* Footer */}
        <div className="orca-diff-comment-popover-footer">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>
            {t('auto.components.diff.comments.DiffCommentPopover.2b3ce6d394', 'Cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            aria-label={
              submitLabel ??
              t('auto.components.diff.comments.DiffCommentPopover.5fa4bfebaa', 'Add note')
            }
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
          >
            {submitting
              ? (submittingLabel ??
                t('auto.components.diff.comments.DiffCommentPopover.5e9b3d0c2e', 'Adding...'))
              : (submitLabel ??
                t('auto.components.diff.comments.DiffCommentPopover.5fa4bfebaa', 'Add note'))}
            {!submitting && <CornerDownLeft className="ml-1 size-3 opacity-70" />}
          </Button>
        </div>
      </div>
    </div>
  )
}
