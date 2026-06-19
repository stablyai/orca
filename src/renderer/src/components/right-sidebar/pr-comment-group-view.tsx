import React from 'react'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger
} from '@/components/ui/accordion'
import { cn } from '@/lib/utils'
import {
  getPRCommentGroupCount,
  getPRCommentGroupId,
  getPRCommentGroupRoot,
  type PRCommentGroup
} from '@/lib/pr-comment-groups'
import { translate } from '@/i18n/i18n'
import {
  RightPanelCommentComposer,
  type RightPanelCommentSubmitResult
} from './right-panel-comment-composer'
import { CommentRow } from './pr-comment-row'
import type { PRComment } from '../../../../shared/types'

export function PRCommentGroupView({
  group,
  replyingGroupId,
  selectionControl,
  resolveSelectionAction,
  replyDisabled,
  replyDisabledReason,
  onResolve,
  onStartReply,
  onCancelReply,
  onReply,
  onEditComment,
  onDeleteComment
}: {
  group: PRCommentGroup
  replyingGroupId: string | null
  selectionControl?: React.ReactNode
  resolveSelectionAction?: React.ReactNode
  replyDisabled?: boolean
  replyDisabledReason?: string
  onResolve?: (threadId: string, resolve: boolean) => boolean | Promise<boolean>
  onStartReply?: (groupId: string) => void
  onCancelReply?: () => void
  onReply?: (comment: PRComment, body: string) => Promise<RightPanelCommentSubmitResult>
  onEditComment?: (comment: PRComment, body: string) => Promise<boolean>
  onDeleteComment?: (comment: PRComment) => void | Promise<void>
}): React.JSX.Element {
  const groupId = getPRCommentGroupId(group)
  const root = getPRCommentGroupRoot(group)
  const replyComposer =
    replyingGroupId === groupId && onReply ? (
      <div className={cn('px-3 pb-2', group.kind === 'thread' && 'pl-6')}>
        <RightPanelCommentComposer
          placeholder={translate(
            'auto.components.right.sidebar.checks.panel.content.ba20d1a896',
            'Reply to {{value0}}',
            { value0: root.author }
          )}
          submitLabel="Reply"
          autoFocus
          disabled={replyDisabled}
          disabledReason={replyDisabledReason}
          onCancel={onCancelReply}
          onSubmit={(body) => onReply(root, body)}
        />
      </div>
    ) : null
  const startReply = onStartReply ? () => onStartReply(groupId) : undefined

  if (group.kind === 'standalone') {
    return (
      <div key={group.comment.id}>
        <CommentRow
          comment={group.comment}
          isReply={false}
          showResolve={false}
          showReply={Boolean(onReply)}
          selectionControl={selectionControl}
          resolveSelectionAction={resolveSelectionAction}
          replyDisabled={replyDisabled}
          replyDisabledReason={replyDisabledReason}
          onResolve={onResolve}
          onReply={startReply ? () => startReply() : undefined}
          onEditComment={onEditComment}
          onDeleteComment={onDeleteComment}
        />
        {replyComposer}
      </div>
    )
  }
  return (
    <div key={group.threadId} className="py-0.5">
      <CommentRow
        comment={group.root}
        isReply={false}
        showResolve={true}
        showReply={Boolean(onReply)}
        selectionControl={selectionControl}
        resolveSelectionAction={resolveSelectionAction}
        replyDisabled={replyDisabled}
        replyDisabledReason={replyDisabledReason}
        onResolve={onResolve}
        onReply={startReply ? () => startReply() : undefined}
        onEditComment={onEditComment}
        onDeleteComment={onDeleteComment}
      />
      {group.replies.length > 0 && (
        <div className="ml-3 border-l-2 border-border/50">
          {group.replies.map((reply) => (
            <CommentRow
              key={reply.id}
              comment={reply}
              isReply={true}
              showResolve={false}
              showReply={false}
              onResolve={onResolve}
              onEditComment={onEditComment}
              onDeleteComment={onDeleteComment}
            />
          ))}
        </div>
      )}
      {replyComposer}
    </div>
  )
}

export function ResolvedCommentGroupAccordion({
  group,
  replyingGroupId,
  replyDisabled,
  replyDisabledReason,
  onResolve,
  onStartReply,
  onCancelReply,
  onReply,
  onEditComment,
  onDeleteComment
}: {
  group: PRCommentGroup
  replyingGroupId: string | null
  replyDisabled?: boolean
  replyDisabledReason?: string
  onResolve?: (threadId: string, resolve: boolean) => boolean | Promise<boolean>
  onStartReply?: (groupId: string) => void
  onCancelReply?: () => void
  onReply?: (comment: PRComment, body: string) => Promise<RightPanelCommentSubmitResult>
  onEditComment?: (comment: PRComment, body: string) => Promise<boolean>
  onDeleteComment?: (comment: PRComment) => void | Promise<void>
}): React.JSX.Element {
  const root = getPRCommentGroupRoot(group)
  const count = getPRCommentGroupCount(group)
  return (
    <Accordion type="single" collapsible>
      <AccordionItem value={getPRCommentGroupId(group)} className="border-b-0">
        <AccordionTrigger className="px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-accent/35">
          <span className="min-w-0 truncate">
            {translate('auto.components.right.sidebar.checks.panel.content.8987d5a3dd', 'Resolved')}{' '}
            {group.kind === 'thread'
              ? translate('auto.components.right.sidebar.checks.panel.content.95ad090b01', 'thread')
              : translate(
                  'auto.components.right.sidebar.checks.panel.content.90206b6353',
                  'comment'
                )}{' '}
            {translate('auto.components.right.sidebar.checks.panel.content.0fc6f743b3', 'by')}{' '}
            {root.author}
            {count > 1 ? ` (${count})` : ''}
          </span>
        </AccordionTrigger>
        <AccordionContent className="pb-1 pt-0">
          <PRCommentGroupView
            group={group}
            replyingGroupId={replyingGroupId}
            replyDisabled={replyDisabled}
            replyDisabledReason={replyDisabledReason}
            onResolve={onResolve}
            onStartReply={onStartReply}
            onCancelReply={onCancelReply}
            onReply={onReply}
            onEditComment={onEditComment}
            onDeleteComment={onDeleteComment}
          />
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  )
}
