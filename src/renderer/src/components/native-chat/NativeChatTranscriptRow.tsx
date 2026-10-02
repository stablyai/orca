import { memo } from 'react'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import { cn } from '@/lib/utils'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import { MessageRow, type NativeChatDeliveryNotice } from './NativeChatMessageRow'
import type { NativeChatImageLoadContext } from './NativeChatImageAttachments'
import { NativeChatResolutionReceipt } from './NativeChatResolutionReceipt'
import { NativeChatWorkingStatus } from './NativeChatWorkingStatus'
import { NativeChatTurnDiffRollup } from './NativeChatTurnDiffRollup'
import { NativeChatSubagentSectionHead } from './NativeChatSubagentSectionHead'
import { NativeChatSubagentEntries } from './NativeChatSubagentRun'
import type { NativeChatSubagentDisclosure } from './native-chat-subagent-sections'
import { AgentSubagentTurnLink } from '../agent-subagents/AgentSubagentContext'
import type { NativeChatTaskListPredecessors } from './native-chat-task-list-history'
import type { NativeChatTranscriptSlot } from './native-chat-transcript-slots'
import type { NativeChatDiffReveal, NativeChatDiffTarget } from './native-chat-turn-diffs'

/** Everything a row needs that is the same for every row. Held as one memoized
 *  object so a row's props change only when that row's own slot does. */
export type NativeChatTranscriptRowContext = {
  expandSignal: boolean
  revealedDiff: NativeChatDiffReveal | null
  taskListPredecessors: ReadonlyMap<string, NativeChatTaskListPredecessors>
  expandedTurnIds: ReadonlySet<string>
  /** Keyed by message id: the user messages that did not go through, each with its own words. */
  deliveryNotices?: ReadonlyMap<string, NativeChatDeliveryNotice>
  subagentSourceKey?: string
  allowFileUriLinks: boolean
  runtimeContext?: RuntimeFileOperationArgs | null
  imageLoadContext?: NativeChatImageLoadContext
  onLinkClick?: CommentMarkdownLinkClickHandler
  onToggleExpandedTurn: (turnKey: string) => void
  subagentDisclosure: NativeChatSubagentDisclosure
  onScrollMessageToTop: (element: HTMLElement) => void
  onRevealDiff: (target: NativeChatDiffTarget) => void
}

/** One transcript row: the message (or the receipt standing in for it), the turn
 *  status under it, and the turn's diff rollup.
 *
 *  These three were siblings in the transcript column and took their spacing from
 *  it. Windowing needs one element per row to position and measure, so the
 *  wrapper carries that spacing itself — the gap BETWEEN rows is the window's. */
export const NativeChatTranscriptRow = memo(function NativeChatTranscriptRow({
  slot,
  context
}: {
  slot: NativeChatTranscriptSlot
  context: NativeChatTranscriptRowContext
}): React.JSX.Element {
  // A subagent's section is set off from the conversation it sits in.
  const sectionClassName = cn(
    slot.depth > 0 && 'border-l-2 border-border/60 pl-3',
    slot.depth > 1 && 'ml-4'
  )
  if (slot.kind === 'subagent') {
    return (
      <div className={sectionClassName}>
        <NativeChatSubagentSectionHead
          agentId={slot.agentId}
          entry={slot.entry}
          expanded={slot.expanded}
          onSetOpen={context.subagentDisclosure.setSectionOpen}
        />
      </div>
    )
  }
  if (slot.kind === 'subagent-entries') {
    return (
      <NativeChatSubagentEntries
        agents={slot.agents}
        sections={slot.sections}
        onSetSectionOpen={context.subagentDisclosure.setSectionOpen}
        // The type its roster row's list inherits, so both halves of the list match.
        className="text-xs leading-relaxed text-muted-foreground"
      />
    )
  }
  const { message, turnKey, status, receipt, turnDiff } = slot
  const predecessors = context.taskListPredecessors.get(message.id)
  const expanded = turnKey ? context.expandedTurnIds.has(turnKey) : undefined
  const statusRow = status ? (
    <NativeChatWorkingStatus
      startedAt={status.startedAt}
      workedSeconds={status.workedSeconds}
      verdict={status.verdict}
      expanded={expanded === true}
      onToggleExpanded={
        slot.turnFolds && turnKey ? () => context.onToggleExpandedTurn(turnKey) : undefined
      }
    />
  ) : null
  return (
    <div className={cn('flex flex-col gap-5', sectionClassName)}>
      {/* A turn with no user bubble carries its bar above its first row. */}
      {slot.statusAbove ? statusRow : null}
      {receipt ? (
        <NativeChatResolutionReceipt body={receipt} disclosureId={message.id} />
      ) : (
        <MessageRow
          message={message}
          previousTodoWrite={predecessors?.todowrite}
          previousUpdatePlan={predecessors?.update_plan}
          revealedDiff={
            context.revealedDiff?.messageId === message.id ? context.revealedDiff : undefined
          }
          expandSignal={context.expandSignal}
          activeTurnIsWorking={slot.activeTurnIsWorking}
          trailingRun={slot.trailingRun}
          onScrollMessageToTop={context.onScrollMessageToTop}
          onLinkClick={context.onLinkClick}
          allowFileUriLinks={context.allowFileUriLinks}
          deliveryNotice={context.deliveryNotices?.get(message.id)}
          folded={slot.folded}
          subagentRoster={slot.subagentRoster}
          subagentDisclosure={context.subagentDisclosure}
          inSubagentSection={slot.depth > 0}
          runtimeContext={context.runtimeContext}
          imageLoadContext={context.imageLoadContext}
        />
      )}
      {slot.statusAbove ? null : statusRow}
      {status && context.subagentSourceKey ? (
        <AgentSubagentTurnLink
          sourceKey={context.subagentSourceKey}
          startedAt={status.startedAt}
          completedAt={
            status.startedAt == null || status.workedSeconds == null
              ? null
              : status.startedAt + status.workedSeconds * 1_000
          }
        />
      ) : null}
      {turnDiff ? (
        <NativeChatTurnDiffRollup diff={turnDiff} onReveal={context.onRevealDiff} />
      ) : null}
    </div>
  )
})
