import React from 'react'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger
} from '@/components/ui/accordion'
import {
  getPRCommentGroupCount,
  getPRCommentGroupId,
  getPRCommentGroupRoot,
  isResolvedPRCommentGroup,
  type PRCommentGroup
} from '../../../../../shared/pr-comment-groups'
import { translate } from '@/i18n/i18n'
import type { GitHubOwnerRepo, GitHubPRFile } from '../../../../../shared/github/pull-request-types'
import type { PRComment } from '../../../../../shared/github/comment-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { MentionOption } from '../page-types'
import { ConversationCommentCard } from './comment-card'

export function ConversationCommentGroup({
  group,
  repoPath,
  repoId,
  sourceContext,
  prNumber,
  prRepo,
  files,
  headSha,
  baseSha,
  markdownGitHubRepo,
  mentionOptions,
  resolvedReplyingTo,
  onToggleReply,
  onSubmitReply
}: {
  group: PRCommentGroup
  repoPath: string | null
  repoId: string
  sourceContext?: TaskSourceContext | null
  prNumber: number
  prRepo: GitHubOwnerRepo | null
  files: GitHubPRFile[]
  headSha: string | undefined
  baseSha: string | undefined
  markdownGitHubRepo: { owner: string; repo: string; host?: string } | null
  mentionOptions: MentionOption[]
  resolvedReplyingTo: number | null
  onToggleReply: (commentId: number) => void
  onSubmitReply: (comment: PRComment, replyBody: string) => Promise<boolean>
}): React.JSX.Element {
  const cardProps = {
    repoPath,
    repoId,
    sourceContext,
    prNumber,
    prRepo,
    files,
    headSha,
    baseSha,
    markdownGitHubRepo,
    mentionOptions,
    resolvedReplyingTo,
    onToggleReply,
    onSubmitReply
  }
  const cards =
    group.kind === 'thread'
      ? [
          <ConversationCommentCard key={group.root.id} comment={group.root} {...cardProps} />,
          ...group.replies.map((reply) => (
            <ConversationCommentCard key={reply.id} comment={reply} isReply {...cardProps} />
          ))
        ]
      : [<ConversationCommentCard key={group.comment.id} comment={group.comment} {...cardProps} />]

  if (!isResolvedPRCommentGroup(group)) {
    return (
      <div key={getPRCommentGroupId(group)} className="flex min-w-0 flex-col gap-3">
        {cards}
      </div>
    )
  }

  const root = getPRCommentGroupRoot(group)
  const count = getPRCommentGroupCount(group)
  return (
    <Accordion key={getPRCommentGroupId(group)} type="single" collapsible>
      <AccordionItem
        value={getPRCommentGroupId(group)}
        className="rounded-lg border border-border/40 bg-card"
      >
        <AccordionTrigger className="px-3 py-2 text-[13px] text-muted-foreground hover:bg-accent/30">
          <span className="min-w-0 truncate">
            {translate('auto.components.PullRequestPage.f4fe47c2bb', 'Resolved')}{' '}
            {group.kind === 'thread'
              ? translate('auto.components.PullRequestPage.345b68254c', 'thread')
              : translate('auto.components.PullRequestPage.e01e34f5fa', 'comment')}{' '}
            {translate('auto.components.PullRequestPage.3c891789f6', 'by')} {root.author}
            {count > 1 ? ` (${count})` : ''}
          </span>
        </AccordionTrigger>
        <AccordionContent className="flex min-w-0 flex-col gap-3 px-3 pb-3 pt-0">
          {cards}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  )
}
