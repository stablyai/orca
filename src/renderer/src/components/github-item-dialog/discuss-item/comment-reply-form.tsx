import React, { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import { cn } from '@/lib/class-names'
import { GitHubMarkdownComposer } from '@/components/github/GitHubMarkdownComposer'
import type { GitHubImageUploadAddress } from '@/components/github/github-image-upload'
import {
  getCommentBodySubmitState,
  hasBoundedCommentBodyText
} from '@/lib/source-control/review/comments/comment-body-submit-state'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'

export function CommentReplyForm({
  imageUploadAddress,
  className,
  placeholder,
  onCancel,
  onSubmit
}: {
  imageUploadAddress?: GitHubImageUploadAddress
  className?: string
  placeholder: string
  onCancel: () => void
  onSubmit: (body: string) => Promise<boolean>
}): React.JSX.Element {
  const t = useTranslate()
  const [body, setBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [uploading, setUploading] = useState(false)
  const mountedRef = useMountedRef()

  const submit = useCallback(async () => {
    const bodyState = getCommentBodySubmitState(body)
    if (bodyState.status === 'empty' || submitting || uploading) {
      return
    }
    if (bodyState.status === 'too-large-leading-whitespace') {
      toast.error(
        translate(
          'auto.components.GitHubItemDialog.commentTooLarge',
          'Comment is too large to submit safely.'
        )
      )
      return
    }
    setSubmitting(true)
    try {
      const ok = await onSubmit(bodyState.body)
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
  }, [body, mountedRef, onSubmit, submitting, uploading])
  const canSubmitReply = hasBoundedCommentBodyText(body)

  return (
    <div className={cn('rounded-md border border-border/50 bg-background/60 p-2', className)}>
      <GitHubMarkdownComposer
        imageUploadAddress={imageUploadAddress}
        onImageUploadPendingChange={setUploading}
        value={body}
        onChange={setBody}
        placeholder={placeholder}
        disabled={submitting}
        autoFocus
        minHeightClassName="min-h-24"
        onSubmitShortcut={() => void submit()}
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t('auto.components.GitHubItemDialog.675bc0d638', 'Cancel')}
        </Button>
        <Button
          size="sm"
          disabled={!canSubmitReply || submitting || uploading}
          onClick={() => void submit()}
        >
          {submitting
            ? t('auto.components.GitHubItemDialog.5752c25aff', 'Posting…')
            : t('auto.components.GitHubItemDialog.f64dd90102', 'Reply')}
        </Button>
      </div>
    </div>
  )
}
