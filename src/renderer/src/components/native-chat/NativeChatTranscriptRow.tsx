import { memo } from 'react'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import { MessageRow } from './NativeChatMessageRow'
import { NativeChatResolutionReceipt } from './NativeChatResolutionReceipt'
import { NativeChatWorkingStatus } from './NativeChatWorkingStatus'
import { NativeChatTurnDiffRollup } from './NativeChatTurnDiffRollup'
import type { NativeChatTaskListPredecessors } from './native-chat-task-list-history'
import type { NativeChatTranscriptSlot } from './native-chat-transcript-slots'
import type { NativeChatDiffReveal, NativeChatDiffTarget } from './native-chat-turn-diffs'

/** Everything a row needs that is the same for every row. Held as one memoized
 *  object so a row's props change only when that row's own slot does. */
export type NativeChatTranscriptRowContext = {
  expandSignal: boolean
  showTurnStatus: boolean
  revealedDiff: NativeChatDiffReveal | null
  taskListPredecessors: ReadonlyMap<string, NativeChatTaskListPredecessors>
  expandedTurnIds: ReadonlySet<string>
  failedDeliveryMessageIds?: ReadonlySet<string>
  allowFileUriLinks: boolean
  runtimeContext?: RuntimeFileOperationArgs | null
  onLinkClick?: CommentMarkdownLinkClickHandler
  onToggleExpandedTurn: (turnKey: string) => void
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
  const { message, turnKey, status, receipt, turnDiff } = slot
  const predecessors = context.taskListPredecessors.get(message.id)
  const expanded = turnKey ? context.expandedTurnIds.has(turnKey) : undefined
  return (
    <div className="flex flex-col gap-5">
      {receipt ? (
        <NativeChatResolutionReceipt body={receipt} />
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
          onScrollMessageToTop={context.onScrollMessageToTop}
          onLinkClick={context.onLinkClick}
          allowFileUriLinks={context.allowFileUriLinks}
          deliveryFailed={context.failedDeliveryMessageIds?.has(message.id) === true}
          structuredActivityUi={context.showTurnStatus}
          activityExpandOverride={expanded}
          runtimeContext={context.runtimeContext}
        />
      )}
      {status ? (
        <NativeChatWorkingStatus
          startedAt={status.startedAt}
          thinking={status.thinking}
          workedSeconds={status.workedSeconds}
          expanded={expanded === true}
          onToggleExpanded={
            status.workedSeconds != null && turnKey
              ? () => context.onToggleExpandedTurn(turnKey)
              : undefined
          }
        />
      ) : null}
      {turnDiff ? (
        <NativeChatTurnDiffRollup diff={turnDiff} onReveal={context.onRevealDiff} />
      ) : null}
    </div>
  )
})
