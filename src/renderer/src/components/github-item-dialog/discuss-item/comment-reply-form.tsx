import React, { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import { cn } from '@/lib/utils'
import { GitHubMarkdownComposer } from '@/components/github/GitHubMarkdownComposer'
import {
  getCommentBodySubmitState,
  hasBoundedCommentBodyText
} from '@/lib/comment-body-submit-state'
import { translate } from '@/i18n/i18n'

export function CommentReplyForm({
  className,
  placeholder,
  onCancel,
  onSubmit
}: {
  className?: string
  placeholder: string
  onCancel: () => void
  onSubmit: (body: string) => Promise<boolean>
}): React.JSX.Element {
  const [body, setBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const mountedRef = useMountedRef()

  const submit = useCallback(async () => {
    const bodyState = getCommentBodySubmitState(body)
    if (bodyState.status === 'empty' || submitting) {
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
  }, [body, mountedRef, onSubmit, submitting])
  const canSubmitReply = hasBoundedCommentBodyText(body)

  return (
    <div className={cn('rounded-md border border-border/50 bg-background/60 p-2', className)}>
      <GitHubMarkdownComposer
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
          {translate('auto.components.GitHubItemDialog.675bc0d638', 'Cancel')}
        </Button>
        <Button size="sm" disabled={!canSubmitReply || submitting} onClick={() => void submit()}>
          {submitting
            ? translate('auto.components.GitHubItemDialog.5752c25aff', 'Posting…')
            : translate('auto.components.GitHubItemDialog.f64dd90102', 'Reply')}
        </Button>
      </div>
    </div>
  )
}
