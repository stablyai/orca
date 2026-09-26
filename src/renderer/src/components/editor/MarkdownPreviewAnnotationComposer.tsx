import { useCallback, useEffect, useRef, useState } from 'react'
import { CornerDownLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { formatMarkdownReviewNotes, type MarkdownReviewNote } from '@/lib/markdown-review-notes'
import { installOpenDraftAddReviewNoteGuard } from './editor-shortcuts'
import { NotesSendMenu } from './NotesSendMenu'

export function MarkdownPreviewSingleNoteSendMenu({
  worktreeId,
  filePath,
  content,
  note,
  modeSlot,
  onDelivered
}: {
  worktreeId: string
  filePath: string
  content: string
  note: MarkdownReviewNote
  modeSlot: string
  onDelivered: (notes: readonly MarkdownReviewNote[]) => void
}): React.JSX.Element {
  return (
    <NotesSendMenu
      worktreeId={worktreeId}
      groupId={worktreeId}
      modeIdParts={['markdown-notes', worktreeId, filePath, modeSlot, note.id]}
      scopes={[
        {
          id: 'note',
          label: translate('auto.components.editor.MarkdownPreview.f37b98999e', 'This note'),
          notes: note.sentAt ? [] : [note],
          prompt: formatMarkdownReviewNotes([note], content)
        }
      ]}
      targetModeLabel="This note"
      triggerClassName="orca-diff-comment-pill-btn"
      disabledTooltip="Note already sent"
      onDelivered={onDelivered}
    />
  )
}

export function MarkdownPreviewAnnotationComposer({
  onCancel,
  onSubmit
}: {
  lineNumber: number
  startLine?: number
  onCancel: () => void
  onSubmit: (body: string) => Promise<boolean>
}): React.JSX.Element {
  const [body, setBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const mountedRef = useMountedRef()
  const composerRef = useRef<HTMLDivElement | null>(null)

  // Why: scope the add-review-note chord to this composer subtree.
  useEffect(() => {
    const composer = composerRef.current
    if (!composer) {
      return
    }
    return installOpenDraftAddReviewNoteGuard(composer)
  }, [])

  const focusTextareaRef = useCallback((textarea: HTMLTextAreaElement | null): void => {
    textarea?.focus()
  }, [])

  const trimmed = body.trim()

  const submit = async (): Promise<void> => {
    if (submitting || !trimmed) {
      return
    }
    setSubmitting(true)
    try {
      const ok = await onSubmit(trimmed)
      if (!mountedRef.current) {
        return
      }
      if (ok) {
        setBody('')
      }
    } finally {
      if (mountedRef.current) {
        setSubmitting(false)
      }
    }
  }

  return (
    <div
      ref={composerRef}
      className="markdown-annotation-composer"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="orca-diff-comment-popover-label">
        {translate('auto.components.editor.MarkdownPreview.b1bfc04034', 'Selected text')}
      </div>
      <textarea
        ref={focusTextareaRef}
        className="orca-diff-comment-popover-textarea"
        placeholder={translate(
          'auto.components.editor.MarkdownPreview.d737791433',
          'Add note for the AI'
        )}
        value={body}
        onChange={(event) => {
          setBody(event.target.value)
          const el = event.currentTarget
          el.style.height = 'auto'
          el.style.height = `${Math.min(el.scrollHeight, 240)}px`
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
            return
          }
          if (event.key === 'Enter' && !event.nativeEvent.isComposing && !event.shiftKey) {
            event.preventDefault()
            void submit()
          }
        }}
        rows={3}
      />
      <div className="orca-diff-comment-popover-footer">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>
          {translate('auto.components.editor.MarkdownPreview.e4683f70c4', 'Cancel')}
        </Button>
        <Button size="sm" onClick={() => void submit()} disabled={submitting || !trimmed}>
          {submitting
            ? translate('auto.components.editor.MarkdownPreview.d652c87c91', 'Saving…')
            : translate('auto.components.editor.MarkdownPreview.13f94d760c', 'Add note')}
          {!submitting && <CornerDownLeft className="ml-1 size-3 opacity-70" />}
        </Button>
      </div>
    </div>
  )
}
