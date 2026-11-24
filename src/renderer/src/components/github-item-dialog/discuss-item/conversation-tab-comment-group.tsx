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
} from '../../../../../shared/source-control/review-comments/pr-comment-groups'
import { useTranslate } from '@/i18n/use-translate'
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
  const t = useTranslate()
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
            {group.kind === 'thread'
              ? t(
                  'auto.components.GitHubItemDialog.resolvedThreadBy',
                  'Resolved thread by {{author}}',
                  {
                    author: root.author
                  }
                )
              : t(
                  'auto.components.GitHubItemDialog.resolvedCommentBy',
                  'Resolved comment by {{author}}',
                  {
                    author: root.author
                  }
                )}
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
