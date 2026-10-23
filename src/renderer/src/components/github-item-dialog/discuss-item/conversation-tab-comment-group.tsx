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
import {
  ConversationTabCommentCard,
  type ConversationTabCommentCardProps
} from './conversation-tab-comment-card'

export function ConversationTabCommentGroup({
  group,
  ...commentCardProps
}: { group: PRCommentGroup } & Omit<
  ConversationTabCommentCardProps,
  'comment' | 'isReply'
>): React.JSX.Element {
  const cards =
    group.kind === 'thread'
      ? [
          <ConversationTabCommentCard
            key={group.root.id}
            comment={group.root}
            {...commentCardProps}
          />,
          ...group.replies.map((reply) => (
            <ConversationTabCommentCard
              key={reply.id}
              comment={reply}
              isReply
              {...commentCardProps}
            />
          ))
        ]
      : [
          <ConversationTabCommentCard
            key={group.comment.id}
            comment={group.comment}
            {...commentCardProps}
          />
        ]

  if (!isResolvedPRCommentGroup(group)) {
    return <div className="flex min-w-0 flex-col gap-3">{cards}</div>
  }

  const root = getPRCommentGroupRoot(group)
  const count = getPRCommentGroupCount(group)
  return (
    <Accordion type="single" collapsible>
      <AccordionItem
        value={getPRCommentGroupId(group)}
        className="rounded-lg border border-border/40 bg-card/40"
      >
        <AccordionTrigger className="px-3 py-2 text-[13px] text-muted-foreground hover:bg-accent/30">
          <span className="min-w-0 truncate">
            {translate('auto.components.GitHubItemDialog.228e2f59d3', 'Resolved')}{' '}
            {group.kind === 'thread'
              ? translate('auto.components.GitHubItemDialog.28d0d3374f', 'thread')
              : translate('auto.components.GitHubItemDialog.e2bf3e41a9', 'comment')}{' '}
            {translate('auto.components.GitHubItemDialog.0ae387d8ca', 'by')} {root.author}
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
