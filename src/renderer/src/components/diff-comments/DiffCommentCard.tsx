import { ImeTextarea } from '@/lib/text-input/ime/ime-text-field'
import { CornerDownLeft, Pencil, Trash } from 'lucide-react'
import { useCallback, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { getDiffCommentLineMetaLabel } from './diff-comment-line-meta-label'
import { DiffCommentFileSession, type DiffCommentComposerSnapshot } from './diff-comment-session'
import { useLocalDiffCommentSession } from './use-local-diff-comment-session'
import { useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import {
  observeDiffCommentZoneSize,
  untilDiffCommentZoneRemoved
} from './diff-comment-zone-lifetime'

// Render note cards in per-zone React roots; keep persisted DiffComment names while UI says Note to distinguish PR review comments.

type Props = {
  lineNumber: number
  startLine?: number
  label?: string | null
  quote?: string
  body: string
  sentAt?: number
  author?: string
  createdAtLabel?: string
  url?: string
  onDelete?: () => void
  // Monaco zones do not auto-measure; notify the decorator when wrapping/growth needs a new heightInPx.
  onContentResize?: () => void
  observeRenderedSize?: boolean
  onSubmitEdit?: (body: string) => Promise<boolean>
  headerActions?: ReactNode
  lifetime?: AbortSignal
  preventScrollOnFocus?: boolean
  session?: DiffCommentFileSession
  commentId?: string
}

const NO_EDIT: DiffCommentComposerSnapshot = { body: '', phase: 'canceled' }
const getNoEdit = (): DiffCommentComposerSnapshot => NO_EDIT
const subscribeNoEdit = (): (() => void) => () => {}

function resizeDiffCommentTextarea(textarea: HTMLTextAreaElement): boolean {
  const previousHeight = textarea.style.height
  textarea.style.height = 'auto'
  textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`
  return textarea.style.height !== previousHeight
}

export function DiffCommentCard({
  lineNumber,
  startLine,
  label,
  quote,
  body,
  sentAt,
  author,
  createdAtLabel,
  url,
  onDelete,
  onContentResize,
  observeRenderedSize,
  onSubmitEdit,
  headerActions,
  lifetime,
  preventScrollOnFocus = false,
  session,
  commentId = 'note'
}: Props): React.JSX.Element {
  const t = useTranslate()
  // Zone cards live in separate React roots, so subscribe directly to language changes.
  useUiLanguageRevision()
  const fileSession = useLocalDiffCommentSession(() => new DiffCommentFileSession(), session)
  const edit = useSyncExternalStore(
    useCallback(
      (listener) => fileSession.subscribeEdit(commentId, listener),
      [fileSession, commentId]
    ),
    useCallback(() => fileSession.getEdit(commentId), [fileSession, commentId])
  )
  const composer = useSyncExternalStore(
    edit?.subscribe ?? subscribeNoEdit,
    edit?.getSnapshot ?? getNoEdit
  )
  const editing = edit !== null
  const draft = composer.body
  const submitting = composer.phase === 'submitting'
  const cardRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const resizeAfterCloseRef = useRef(false)
  const focusRequestedRef = useRef(false)
  const observesRenderedSize = observeRenderedSize === true && onContentResize !== undefined

  // Read the latest resize callback without rerunning edit layout; fresh parent arrows would move the caret to the end mid-edit.
  const onContentResizeRef = useRef(onContentResize)
  onContentResizeRef.current = onContentResize

  useLayoutEffect(() => {
    const card = cardRef.current
    if (!card || lifetime?.aborted || !observesRenderedSize) {
      return
    }
    onContentResizeRef.current?.()
    let frameId: number | null = null
    const notifyResize = (): void => {
      if (frameId !== null) {
        return
      }
      frameId = requestAnimationFrame(() => {
        frameId = null
        onContentResizeRef.current?.()
      })
    }
    if (typeof ResizeObserver === 'undefined') {
      return untilDiffCommentZoneRemoved(lifetime, () => {
        if (frameId !== null) {
          cancelAnimationFrame(frameId)
        }
      })
    }
    // Initial Monaco estimates miss narrow-pane wrapping; observe actual card height in both diff layouts.
    return observeDiffCommentZoneSize(lifetime, card, notifyResize, () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId)
      }
    })
  }, [lifetime, observesRenderedSize])

  // Measure the newly edited textarea before paint so its view zone cannot jump on the next frame.
  useLayoutEffect(() => {
    if (lifetime?.aborted) {
      return
    }
    if (!editing) {
      if (resizeAfterCloseRef.current) {
        resizeAfterCloseRef.current = false
        onContentResizeRef.current?.()
      }
      return
    }
    const el = textareaRef.current
    if (!el) {
      return
    }
    resizeDiffCommentTextarea(el)
    resizeAfterCloseRef.current = true
    if (focusRequestedRef.current) {
      focusRequestedRef.current = false
      el.focus(preventScrollOnFocus ? { preventScroll: true } : undefined)
      el.setSelectionRange(el.value.length, el.value.length)
    }
    onContentResizeRef.current?.()
  }, [editing, lifetime, preventScrollOnFocus])

  const handleStartEdit = (): void => {
    focusRequestedRef.current = true
    fileSession.startEdit(commentId, body)
  }

  const handleCancel = (): void => {
    if (edit) {
      fileSession.cancelEdit(commentId, edit)
    }
  }

  const trimmedDraft = draft.trim()
  const canSubmit = !submitting && trimmedDraft.length > 0 && trimmedDraft !== body
  const lineLabel =
    label === undefined ? getDiffCommentLineMetaLabel({ lineNumber, startLine }, t) : label
  const metaText = [
    author || t('auto.components.diff.comments.DiffCommentCard.noteAuthorFallback', 'Note'),
    lineLabel,
    createdAtLabel ||
      (sentAt ? t('auto.components.diff.comments.DiffCommentCard.sentMeta', 'sent') : null)
  ]
    .filter(Boolean)
    .join(' ')

  const handleSubmit = (): void => {
    if (lifetime?.aborted || !canSubmit || !onSubmitEdit || !edit) {
      return
    }
    void fileSession.submitEdit(commentId, edit, onSubmitEdit, trimmedDraft).catch((err) => {
      console.error('Failed to submit diff comment edit:', err)
    })
  }

  return (
    <div ref={cardRef} className="orca-diff-comment-card">
      <div className="orca-diff-comment-content-col">
        {/* Header Row */}
        <div className="orca-diff-comment-header">
          <div className="orca-diff-comment-meta-group">{metaText}</div>

          {/* Action buttons pill (only shown if not editing) */}
          {!editing && (
            <div
              className="orca-diff-comment-actions-pill"
              onMouseDown={(ev) => ev.stopPropagation()}
            >
              {headerActions}
              {headerActions && (url || onSubmitEdit || onDelete) && (
                <span className="orca-diff-comment-pill-divider" />
              )}
              {url && (
                <>
                  <button
                    type="button"
                    className="orca-diff-comment-pill-btn"
                    title={t(
                      'auto.components.diff.comments.DiffCommentCard.508ee678a5',
                      'Open in browser'
                    )}
                    aria-label={t(
                      'auto.components.diff.comments.DiffCommentCard.508ee678a5',
                      'Open in browser'
                    )}
                    onClick={(ev) => {
                      ev.preventDefault()
                      ev.stopPropagation()
                      openAppHttpLink(url, { event: ev })
                    }}
                  >
                    {t('auto.components.diff.comments.DiffCommentCard.6978871a3d', 'Open')}
                  </button>
                  {(onSubmitEdit || onDelete) && (
                    <span className="orca-diff-comment-pill-divider" />
                  )}
                </>
              )}
              {onSubmitEdit && (
                <>
                  <button
                    type="button"
                    className="orca-diff-comment-pill-btn"
                    title={t(
                      'auto.components.diff.comments.DiffCommentCard.cad3384faa',
                      'Edit note'
                    )}
                    aria-label={t(
                      'auto.components.diff.comments.DiffCommentCard.cad3384faa',
                      'Edit note'
                    )}
                    onClick={(ev) => {
                      ev.preventDefault()
                      ev.stopPropagation()
                      handleStartEdit()
                    }}
                  >
                    <Pencil className="size-3" />
                  </button>
                  {onDelete && <span className="orca-diff-comment-pill-divider" />}
                </>
              )}
              {onDelete && (
                <button
                  type="button"
                  className="orca-diff-comment-pill-btn orca-diff-comment-pill-btn-danger"
                  title={t(
                    'auto.components.diff.comments.DiffCommentCard.cce596969e',
                    'Delete note'
                  )}
                  aria-label={t(
                    'auto.components.diff.comments.DiffCommentCard.cce596969e',
                    'Delete note'
                  )}
                  onClick={(ev) => {
                    ev.preventDefault()
                    ev.stopPropagation()
                    onDelete()
                  }}
                >
                  <Trash className="size-3" />
                </button>
              )}
            </div>
          )}
        </div>

        {/* Quote Block */}
        {quote ? (
          <div className="orca-diff-comment-quote">
            <div className="orca-diff-comment-quote-text">{quote}</div>
          </div>
        ) : null}

        {/* Body or Edit Mode */}
        {editing ? (
          <div className="flex flex-col gap-2 mt-1">
            <ImeTextarea
              ref={textareaRef}
              className="orca-diff-comment-popover-textarea"
              value={draft}
              onChange={(e) => {
                edit?.setBody(e.target.value)
                // Why: rich-review layout measures every note; skip it when this card stayed put.
                if (resizeDiffCommentTextarea(e.currentTarget)) {
                  onContentResizeRef.current?.()
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  handleCancel()
                  return
                }
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
                {t('auto.components.diff.comments.DiffCommentCard.0203bed775', 'Cancel')}
              </Button>
              <Button
                size="sm"
                onClick={() => void handleSubmit()}
                disabled={!canSubmit}
                title={
                  submitting
                    ? t('auto.components.diff.comments.DiffCommentCard.bb0a55f856', 'Saving…')
                    : undefined
                }
              >
                {t('auto.components.diff.comments.DiffCommentCard.109a791e7b', 'Save')}
                <CornerDownLeft className="ml-1 size-3 opacity-70" />
              </Button>
            </div>
          </div>
        ) : (
          <div className="orca-diff-comment-body">{body}</div>
        )}
      </div>
    </div>
  )
}
