import React, { useCallback, useState } from 'react'
import { LoaderCircle, Send } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { GitHubMarkdownComposer } from '@/components/github/GitHubMarkdownComposer'
import {
  getCommentBodySubmitState,
  hasBoundedCommentBodyText
} from '@/lib/comment-body-submit-state'
import { addIssueCommentForRepo } from '@/components/github/github-work-item-comment-mutations'
import type { PRComment } from '../../../../../shared/github/comment-types'
import type { GitHubOwnerRepo } from '../../../../../shared/github/pull-request-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import { translate } from '@/i18n/i18n'

export function GHCommentComposer({
  className,
  repoPath,
  repoId,
  sourceContext,
  issueNumber,
  itemType,
  prRepo,
  onCommentAdded
}: {
  className?: string
  repoPath: string
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
  issueNumber: number
  itemType: 'issue' | 'pr'
  prRepo?: GitHubOwnerRepo | null
  onCommentAdded: (comment: PRComment) => void
}): React.JSX.Element {
  const [body, setBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const mountedRef = useMountedRef()

  const handleSubmit = useCallback(async () => {
    const bodyState = getCommentBodySubmitState(body)
    if (bodyState.status === 'empty') {
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
      const result = await addIssueCommentForRepo({
        repoPath,
        repoId: repoId ?? undefined,
        sourceContext,
        number: issueNumber,
        body: bodyState.body,
        type: itemType,
        prRepo
      })
      if (!mountedRef.current) {
        return
      }
      if (result.ok) {
        setBody('')
        // Why: use GitHub's returned comment so the optimistic row shows the real login/avatar immediately.
        onCommentAdded(result.comment)
      } else {
        toast.error(
          result.error ??
            translate('auto.components.GitHubItemDialog.082515176a', 'Failed to add comment')
        )
      }
    } catch (err) {
      if (mountedRef.current) {
        toast.error(
          err instanceof Error
            ? err.message
            : translate('auto.components.GitHubItemDialog.082515176a', 'Failed to add comment')
        )
      }
    } finally {
      if (mountedRef.current) {
        setSubmitting(false)
      }
    }
  }, [
    body,
    mountedRef,
    repoPath,
    repoId,
    sourceContext,
    issueNumber,
    itemType,
    prRepo,
    onCommentAdded
  ])
  const canSubmitComment = hasBoundedCommentBodyText(body)

  return (
    <div className={cn('relative', className)}>
      <GitHubMarkdownComposer
        value={body}
        onChange={setBody}
        placeholder={translate('auto.components.GitHubItemDialog.c5c117270e', 'Add a comment…')}
        disabled={submitting}
        minHeightClassName="min-h-28 pb-14 pr-14"
        className="w-full"
        onSubmitShortcut={() => void handleSubmit()}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            onClick={handleSubmit}
            disabled={!canSubmitComment || submitting}
            className="absolute bottom-3 right-3 shadow-sm"
            aria-label={translate('auto.components.GitHubItemDialog.0a73f59e85', 'Send comment')}
          >
            {submitting ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {translate('auto.components.GitHubItemDialog.0a73f59e85', 'Send comment')}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
