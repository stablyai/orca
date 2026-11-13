import { memo, useContext } from 'react'
import { cn } from '@/lib/class-names'
import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'
import { MessageRow, type NativeChatDeliveryNotice } from './NativeChatMessageRow'
import { NativeChatResolutionReceipt } from '../../prompts/NativeChatResolutionReceipt'
import { NativeChatWorkingStatus } from '../../conversation/turns/NativeChatWorkingStatus'
import { NativeChatTurnDiffRollup } from '../../tools/diffs/NativeChatTurnDiffRollup'
import { NativeChatOpenedPullRequestCard } from '../../tools/pull-requests/NativeChatOpenedPullRequestCard'
import { NativeChatSubagentHead } from '../../subagents/NativeChatSubagentHead'
import type { NativeChatTaskListPredecessors } from '../../../../../../shared/native-chat/input/native-chat-task-list-history'
import type { NativeChatTranscriptSlot } from '../../conversation/slots/native-chat-transcript-slots'
import type { NativeChatTimedRow } from '../../conversation/slots/native-chat-timed-rows'
import type {
  NativeChatDiffReveal,
  NativeChatDiffTarget
} from '../../../../../../shared/native-chat/tools/native-chat-turn-diffs'
import { NativeChatRewindContext } from '../actions/native-chat-rewind-context'
import { nativeChatRowOffersRewind } from '../../../../../../shared/native-chat/native-chat-rewind-eligibility'
import { NativeChatForkContext } from '../actions/native-chat-fork-context'
import { nativeChatSlotOffersFork } from '../actions/native-chat-side-chat-fork-point'
import { isActionableStructuredAgentSessionPrompt } from '../../../../../../shared/agent-session/view/structured-agent-session-live-turn'
import { NativeChatNewRowsMarker } from '../../viewport/new-rows/NativeChatNewRowsMarker'
import type { NativeChatNewRowsMarkerState } from '../../viewport/new-rows/native-chat-new-rows-marker'

/** Memoize shared context so unchanged rows keep their props during transcript updates. */
export type NativeChatTranscriptRowContext = {
  agentName?: string
  /** The prompts the host says still wait on the person; absent from an older host. */
  actionablePromptIds?: readonly string[] | undefined
  expandSignal: boolean
  revealedDiff: NativeChatDiffReveal | null
  taskListPredecessors: ReadonlyMap<string, NativeChatTaskListPredecessors>
  expandedTurnIds: ReadonlySet<string>
  /** The conversation's newest turn, the only one an agent that forks at its tip can fork. */
  latestTurnKey?: string
  /** Keyed by message id: the user messages that did not go through, each with its own words. */
  deliveryNotices?: ReadonlyMap<string, NativeChatDeliveryNotice>
  /** Keyed by message id: rows from outside the conversation that came right after that message. */
  timedRows?: ReadonlyMap<string, readonly NativeChatTimedRow[]>
  structuredAttachments?: boolean
  runtimeContext?: RuntimeFileOperationArgs | null
  onToggleExpandedTurn: (turnKey: string) => void
  /** Opens a subagent's own view; absent where the transcript has none to open. */
  onOpenSubagent?: (agentId: string) => void
  onScrollMessageToTop: (element: HTMLElement) => void
  onRevealDiff: (target: NativeChatDiffTarget) => void
}

/**
 * Margins that space the "New" line evenly between what it separates: a full row gap above (20px
 * at the default size), trimmed below so the next text reads as far from the line as the block above.
 * Above the turn bar, the bar's own top padding asks for a deeper trim. Your sent bubble ends in its
 * hover-only copy and time row; that blank row counts as space above, so the line moves up into it.
 */
function newRowsMarkerSpacing(
  place: NativeChatNewRowsMarkerState['place'],
  slot: Extract<NativeChatTranscriptSlot, { kind: 'message' }>,
  deliveryNotice: NativeChatDeliveryNotice | undefined
): string {
  if (place === 'above-row') {
    return '-mb-1.5'
  }
  const afterHoverMeta =
    slot.drawsMessage &&
    !slot.receipt &&
    slot.message.role === 'user' &&
    !slot.message.from &&
    deliveryNotice === undefined
  return cn('-mb-3', afterHoverMeta && '-mt-6')
}

/** Wrap message, status and rollup for one virtualized measurement; internal spacing is the row’s, inter-row gaps the window’s. */
export const NativeChatTranscriptRow = memo(function NativeChatTranscriptRow({
  slot,
  context,
  newRowsMarker,
  newRowsMarkerBelow = false
}: {
  slot: NativeChatTranscriptSlot
  context: NativeChatTranscriptRowContext
  /** The "New" marker, when it draws in this row. */
  newRowsMarker?: NativeChatNewRowsMarkerState
  /** The "New" marker opens the next row: left-side, so this row's actions keep their own height. */
  newRowsMarkerBelow?: boolean
}): React.JSX.Element {
  // Offered only on the conversation's own turn-opening prompts (`nativeChatRowOffersRewind`).
  const rewind = useContext(NativeChatRewindContext)
  const fork = useContext(NativeChatForkContext)
  if (slot.kind === 'subagent') {
    return (
      <NativeChatSubagentHead
        agentId={slot.agentId}
        entry={slot.entry}
        onOpen={context.onOpenSubagent}
      />
    )
  }
  const { message, turnKey, status, receipt, turnDiff, openedPullRequests, workRun } = slot
  const deliveryNotice = context.deliveryNotices?.get(message.id)
  const predecessors = context.taskListPredecessors.get(message.id)
  const expanded = turnKey ? context.expandedTurnIds.has(turnKey) : undefined
  const marker = newRowsMarker ? (
    <NativeChatNewRowsMarker
      marker={newRowsMarker}
      onReveal={context.onScrollMessageToTop}
      className={newRowsMarkerSpacing(newRowsMarker.place, slot, deliveryNotice)}
    />
  ) : null
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
    // The negative margin shortens the measured row, which is what moves the next one up.
    // A row that holds its response's actions keeps the gap whole: they stay in flow above the
    // agent's next step (`actionsHang` is unset there), which then sits a full gap below them.
    // So does a row the "New" line follows, so the line sits the same full gap below any row.
    <div
      className={cn(
        'flex flex-col gap-5',
        slot.continuesTurn &&
          !(slot.endsResponse && !slot.activeTurnIsWorking) &&
          !newRowsMarkerBelow &&
          '-mb-3'
      )}
    >
      {newRowsMarker?.place === 'above-row' ? marker : null}
      {/* A turn with no user bubble carries its bar above its first row. */}
      {slot.statusAbove ? statusRow : null}
      {!slot.drawsMessage ? null : receipt ? (
        <NativeChatResolutionReceipt
          body={receipt}
          disclosureId={message.id}
          awaiting={isActionableStructuredAgentSessionPrompt(
            message.id,
            context.actionablePromptIds
          )}
        />
      ) : (
        <MessageRow
          message={message}
          agentName={context.agentName}
          previousTodoWrite={predecessors?.todowrite}
          previousUpdatePlan={predecessors?.update_plan}
          revealedDiff={
            (workRun ?? [message]).some((member) => member.id === context.revealedDiff?.messageId)
              ? (context.revealedDiff ?? undefined)
              : undefined
          }
          expandSignal={context.expandSignal}
          activeTurnIsWorking={slot.activeTurnIsWorking}
          trailingRun={slot.trailingRun}
          continuesTurn={slot.continuesTurn}
          endsResponse={slot.endsResponse}
          latestResponse={slot.latestResponse === true}
          actionsHang={slot.actionsHang === true && !newRowsMarkerBelow}
          onScrollMessageToTop={context.onScrollMessageToTop}
          deliveryNotice={deliveryNotice}
          onOpenSubagent={context.onOpenSubagent}
          runtimeContext={context.runtimeContext}
          structuredAttachments={context.structuredAttachments}
          rewind={
            nativeChatRowOffersRewind(
              message,
              { depth: 0, turnKey },
              deliveryNotice !== undefined
            ) &&
            (!rewind?.eligibleItemIds || rewind.eligibleItemIds.has(message.id))
              ? rewind
              : undefined
          }
          fork={
            fork &&
            nativeChatSlotOffersFork(slot, { chat: fork, latestTurnKey: context.latestTurnKey })
              ? fork.rowAction
              : undefined
          }
          workRun={workRun}
        />
      )}
      {newRowsMarker?.place === 'above-turn-bar' ? marker : null}
      {slot.statusAbove ? null : statusRow}
      {turnDiff ? <NativeChatTurnDiffRollup diff={turnDiff} /> : null}
      {openedPullRequests ? (
        <NativeChatOpenedPullRequestCard pullRequests={openedPullRequests} />
      ) : null}
      {context.timedRows?.get(message.id)?.map(({ key, node }) => (
        <div key={key}>{node}</div>
      ))}
    </div>
  )
})
