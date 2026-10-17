import React, { useCallback, useRef, useState } from 'react'
import { LoaderCircle, Send } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useMountedRef } from '@/hooks/useMountedRef'
import { cn } from '@/lib/utils'
import { isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import {
  getCommentBodySubmitState,
  hasBoundedCommentBodyText
} from '@/lib/comment-body-submit-state'
import { addIssueCommentForRepo } from '@/components/github/github-work-item-comment-mutations'
import { translate } from '@/i18n/i18n'
import type { GitHubOwnerRepo } from '../../../../../shared/github/pull-request-types'
import type { PRComment } from '../../../../../shared/github/comment-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { MentionOption } from '../page-types'
import { MentionTextarea } from '../mentions/textarea'

const COMPACT_COMMENT_MAX_HEIGHT = 240
const PANEL_COMMENT_MAX_HEIGHT = 480

/** Compose a general comment for the selected work item and retain its draft after failed sends. */
export function GHCommentComposer({
  className,
  layout = 'compact',
  repoPath,
  repoId,
  sourceContext,
  issueNumber,
  itemType,
  prRepo,
  mentionOptions,
  onCommentAdded
}: {
  className?: string
  layout?: 'compact' | 'panel'
  repoPath: string
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
  issueNumber: number
  itemType: 'issue' | 'pr'
  prRepo?: GitHubOwnerRepo | null
  mentionOptions: MentionOption[]
  onCommentAdded: (comment: PRComment) => void
}): React.JSX.Element {
  const [body, setBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const mountedRef = useMountedRef()
  const panelLayout = layout === 'panel'

  const autoGrow = useCallback(() => {
    const el = textareaRef.current
    if (!el) {
      return
    }
    el.style.height = 'auto'
    const minHeight = panelLayout ? 192 : 80
    const maxHeight = panelLayout ? PANEL_COMMENT_MAX_HEIGHT : COMPACT_COMMENT_MAX_HEIGHT
    el.style.height = `${Math.max(minHeight, Math.min(el.scrollHeight, maxHeight))}px`
  }, [panelLayout])

  const handleSubmit = useCallback(async () => {
    const bodyState = getCommentBodySubmitState(body)
    if (bodyState.status === 'empty') {
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
        requestAnimationFrame(autoGrow)
        // Why: use GitHub's returned comment so the optimistic row shows the real login/avatar without a reopen.
        onCommentAdded(result.comment)
      } else {
        toast.error(
          result.error ??
            translate('auto.components.PullRequestPage.1208347ac0', 'Failed to add comment')
        )
      }
    } catch (err) {
      if (mountedRef.current) {
        toast.error(
          err instanceof Error
            ? err.message
            : translate('auto.components.PullRequestPage.1208347ac0', 'Failed to add comment')
        )
      }
    } finally {
      if (mountedRef.current) {
        setSubmitting(false)
      }
    }
  }, [
    autoGrow,
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

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isScreenSubmitShortcut(e)) {
        e.preventDefault()
        handleSubmit()
      }
    },
    [handleSubmit]
  )

  return (
    <div className={cn('relative', className)}>
      <MentionTextarea
        textareaRef={textareaRef}
        value={body}
        onValueChange={(nextValue) => {
          setBody(nextValue)
          requestAnimationFrame(autoGrow)
        }}
        onKeyDown={handleKeyDown}
        placeholder={translate('auto.components.PullRequestPage.d2030fc8cd', 'Add a comment…')}
        rows={panelLayout ? 8 : 4}
        mentionOptions={mentionOptions}
        wrapperClassName="flex w-full items-stretch"
        className={cn(
          'scrollbar-sleek block w-full resize-none overflow-y-auto rounded-md border border-input bg-card px-3 py-2 pb-12 pr-12 text-[13px] leading-5 placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          panelLayout ? 'h-48 max-h-[480px] min-h-48' : 'h-20 max-h-[240px] min-h-20'
        )}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            onClick={handleSubmit}
            disabled={!canSubmitComment || submitting}
            className="absolute bottom-3 right-3 shadow-sm"
            aria-label={translate('auto.components.PullRequestPage.161d91ef02', 'Send comment')}
          >
            {submitting ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {translate('auto.components.PullRequestPage.161d91ef02', 'Send comment')}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
