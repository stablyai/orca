import React, { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import { cn } from '@/lib/utils'
import { isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import {
  getCommentBodySubmitState,
  hasBoundedCommentBodyText
} from '@/lib/comment-body-submit-state'
import { translate } from '@/i18n/i18n'
import type { MentionOption } from '../page-types'
import { MentionTextarea } from '../mentions/textarea'

export function CommentReplyForm({
  className,
  placeholder,
  mentionOptions,
  onCancel,
  onSubmit
}: {
  className?: string
  placeholder: string
  mentionOptions: MentionOption[]
  onCancel: () => void
  onSubmit: (body: string) => Promise<boolean>
}): React.JSX.Element {
  const [body, setBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const mountedRef = useMountedRef()

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const submit = useCallback(async () => {
    const bodyState = getCommentBodySubmitState(body)
    if (bodyState.status === 'empty' || submitting) {
      return
    }
    if (bodyState.status === 'too-large-leading-whitespace') {
      toast.error(
        translate(
          'auto.components.PullRequestPage.commentTooLarge',
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
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          error instanceof Error
            ? error.message
            : translate('auto.components.PullRequestPage.5821aab360', 'Failed to post reply.')
        )
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
      <MentionTextarea
        textareaRef={textareaRef}
        value={body}
        onValueChange={setBody}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
            return
          }
          if (isScreenSubmitShortcut(e)) {
            e.preventDefault()
            void submit()
          }
        }}
        placeholder={placeholder}
        rows={3}
        mentionOptions={mentionOptions}
        className="scrollbar-sleek min-h-20 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-[13px] placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {translate('auto.components.PullRequestPage.6591b1fa82', 'Cancel')}
        </Button>
        <Button size="sm" disabled={!canSubmitReply || submitting} onClick={() => void submit()}>
          {submitting
            ? translate('auto.components.PullRequestPage.894cfd884b', 'Posting…')
            : translate('auto.components.PullRequestPage.f119e5f5ef', 'Reply')}
        </Button>
      </div>
    </div>
  )
}
