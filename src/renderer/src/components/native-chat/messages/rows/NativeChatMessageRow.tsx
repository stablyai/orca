import { memo, useRef } from 'react'
import type { AgentSessionAccountKind } from '../../../../../../shared/agent-session/failures/agent-session-availability'
import type { NativeChatRewindSurface } from '../actions/use-native-chat-rewind-host'
import type { NativeChatForkRowAction } from '../actions/use-native-chat-fork'
import { NativeChatUserMessageRow } from './NativeChatUserMessageRow'
import { NativeChatAgentMessageCard } from './NativeChatAgentMessageCard'
import { NativeChatAssistantMessageRow } from './NativeChatAssistantMessageRow'
import type {
  NativeChatMessage,
  NativeChatToolCallBlock
} from '../../../../../../shared/native-chat/native-chat-types'
import { isNativeChatOrcaCard } from '../../../../../../shared/native-chat/native-chat-orca-card'
import { nativeChatBotMessageCardOf } from '../../../../../../shared/native-chat/bot-cards/native-chat-bot-card-kind'
import { nativeChatMessageBotCard } from '../../native-chat-bot-cards'
import { deriveNativeChatRowContent } from '../../../../../../shared/native-chat/transcript/row-content/native-chat-row-content'
import { NativeChatReasoningRow } from '../reasoning/NativeChatReasoningRow'
import { NativeChatAutomationResultRow } from '../../automation-run/NativeChatAutomationResultRow'
import { NativeChatWaitEndedRow, NativeChatWaitRow } from '../../automation-run/NativeChatWaitRow'
import { NativeChatAutomationSavedRow } from '../../automation-run/NativeChatAutomationSavedRow'
import { NativeChatBotItemNoteRow } from '../../bot-items/NativeChatBotItemNoteRow'
import { NativeChatAutomationRunRow } from '../../automation-run/NativeChatAutomationRunRow'
import { mergedRunFailures } from '../../../../../../shared/native-chat/transcript/events/native-chat-event-plan'
import { NativeChatNoticeRow } from '../notices/NativeChatNoticeRow'
import { NativeChatSubagentEndingRow } from '../../subagents/NativeChatSubagentEndingRow'
import { isNativeChatSubagentEndingPresentation } from '../../subagents/native-chat-subagent-ending'
import { NativeChatBotCreatedRow, NativeChatTookOverRow } from '../../NativeChatBotCreatedRow'
import { nativeChatNoticeBlock } from '../../../../../../shared/native-chat/transcript/notices/native-chat-notice'
import { nativeChatMessageRowBlocks } from './native-chat-message-row-words'
import { ProviderFrameRow } from '../diagnostics/NativeChatProviderDetails'
import type { NativeChatDiffReveal } from '../../../../../../shared/native-chat/tools/native-chat-turn-diffs'
import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'
import { useNativeChatWorkRun } from '../../tools/runs/use-native-chat-work-run'
import { useNativeChatRowNavigation } from '../actions/use-native-chat-row-navigation'
import { useTranslate } from '@/i18n/use-translate'
import {
  NativeChatGalleryMessageContext,
  nativeChatGalleryMessageId
} from '../../media/images/gallery/native-chat-image-gallery-context'

/** Unconfirmed sending status or a failed-delivery notice with an optional dismissal. */
export type NativeChatDeliveryNotice =
  | {
      sending: true
      text?: never
      onDismiss?: never
      onEdit?: never
      onSend?: never
      detail?: never
      failureKind?: never
      signIn?: never
    }
  | {
      sending?: never
      text: string
      detail?: string
      failureKind?: string
      /** A not-signed-in rejection, for the line's Sign in. */
      signIn?: { agentName: string; account?: AgentSessionAccountKind }
      onDismiss?: () => void
      onEdit?: () => void
      onSend?: () => void
    }

export type MessageRowProps = {
  message: NativeChatMessage
  agentName?: string
  previousTodoWrite?: NativeChatToolCallBlock
  previousUpdatePlan?: NativeChatToolCallBlock
  revealedDiff?: NativeChatDiffReveal
  expandSignal: boolean
  activeTurnIsWorking?: boolean
  /** This row's tool run is the turn's last, so it is the one still live. */
  trailingRun?: boolean
  /** Response controls would overlap the next row. */
  continuesTurn?: boolean
  /** Its turn opens with an automation's row, which already stands for a quiet reply. */
  inAutomationTurn?: boolean
  /** Its turn changed an item, posted or otherwise did something others see. */
  inActingTurn?: boolean
  /** In a turn: whether this row holds the response's actions (its last words, else its last images). */
  endsResponse?: boolean
  latestResponse?: boolean
  /** Response controls may hang into the gap below; otherwise they keep their own height. */
  actionsHang?: boolean
  /** Align this message's top to the top of the scroll viewport. */
  onScrollMessageToTop: (el: HTMLElement) => void
  deliveryNotice?: NativeChatDeliveryNotice
  /** On a roster row: opens one of its subagents in its own view. */
  onOpenSubagent?: (agentId: string) => void
  structuredAttachments?: boolean
  runtimeContext?: RuntimeFileOperationArgs | null
  /** On a user row: discards it and everything after it. */
  rewind?: NativeChatRewindSurface
  /** On a finished response of the chat's own agent: forks the chat through its turn. */
  fork?: NativeChatForkRowAction
  /** All messages in this work run, message first; preserve row identity when a message becomes a run. */
  workRun?: readonly NativeChatMessage[]
}

function rowHasContent(content: ReturnType<typeof deriveNativeChatRowContent>): boolean {
  return (
    content.markdown.length > 0 ||
    content.hasImages ||
    content.tools.length > 0 ||
    content.subagentGroups.length > 0 ||
    content.backgroundTasks.length > 0
  )
}

/** Memoize settled block identities so stream frames rerender only changed rows. */
export const MessageRow = memo(function MessageRow(props: MessageRowProps): React.JSX.Element {
  return (
    <NativeChatGalleryMessageContext
      value={nativeChatGalleryMessageId(props.message, props.activeTurnIsWorking)}
    >
      <MessageRowContent {...props} />
    </NativeChatGalleryMessageContext>
  )
}, sameMessageRowProps)

function MessageRowContent(props: MessageRowProps): React.JSX.Element | null {
  const t = useTranslate()
  const {
    message,
    agentName,
    activeTurnIsWorking,
    onScrollMessageToTop,
    deliveryNotice,
    runtimeContext,
    rewind,
    workRun
  } = props
  const rowRef = useRef<HTMLDivElement | null>(null)
  const blocks = nativeChatMessageRowBlocks(message, t)
  // Share content derivation with slot selection so invisible rows cannot reserve transcript gaps.
  const content = deriveNativeChatRowContent(blocks)
  const { markdown, prose } = content
  const isUser = message.role === 'user'
  const isReasoning = message.role === 'reasoning'
  const isSystem = message.role === 'system'
  const providerFrame = blocks.find((block) => block.type === 'text' && block.providerFrame)
  const run = useNativeChatWorkRun(workRun, {
    revealedDiff: props.revealedDiff,
    activeTurnIsWorking
  })

  const { scrollToTop, returnToView } = useNativeChatRowNavigation(rowRef, onScrollMessageToTop)

  // Return after all hooks to preserve hook order when content disappears.
  if (run === undefined && !rowHasContent(content) && !isNativeChatOrcaCard(message)) {
    return null
  }

  if (message.automationSaved?.automation.once) {
    return (
      <div ref={rowRef} data-native-chat-message-id={message.id}>
        <NativeChatWaitRow
          messageId={message.id}
          automation={message.automationSaved.automation}
          once={message.automationSaved.automation.once}
          ended={message.savedWaitEnded}
          endedOn={message.savedWaitEndedOn}
          timestamp={message.timestamp}
        />
      </div>
    )
  }

  if (message.automationRunNotStarted) {
    const notStarted = message.automationRunNotStarted
    return (
      <div ref={rowRef} data-native-chat-message-id={message.id}>
        <NativeChatAutomationRunRow
          messageId={message.id}
          run={notStarted.run}
          state="not-started"
          text={notStarted.text}
          timestamp={message.timestamp}
          error={notStarted.error}
          refusal={notStarted.refusal}
          earlierFailures={mergedRunFailures(message)}
          resend={notStarted.sentAgain ? 'sent' : 'offer'}
          onRefolded={returnToView}
        />
      </div>
    )
  }

  if (isUser && message.automationRun) {
    return (
      <div ref={rowRef} data-native-chat-message-id={message.id}>
        <NativeChatAutomationRunRow
          messageId={message.id}
          run={message.automationRun}
          state={message.queued ? 'queued' : 'ran'}
          text={markdown}
          timestamp={message.timestamp}
          earlierFailures={mergedRunFailures(message)}
          onRefolded={returnToView}
        />
      </div>
    )
  }

  if (message.waitEnded) {
    return (
      <div ref={rowRef} data-native-chat-message-id={message.id}>
        <NativeChatWaitEndedRow
          messageId={message.id}
          ended={message.waitEnded}
          timestamp={message.timestamp}
        />
      </div>
    )
  }

  if (message.automationSaved) {
    return (
      <div ref={rowRef} data-native-chat-message-id={message.id}>
        <NativeChatAutomationSavedRow
          saved={message.automationSaved}
          timestamp={message.timestamp}
          disclosureId={message.id}
        />
      </div>
    )
  }

  if (message.botItemNote) {
    return (
      <div ref={rowRef} data-native-chat-message-id={message.id}>
        <NativeChatBotItemNoteRow
          note={message.botItemNote}
          timestamp={message.timestamp ?? undefined}
        />
      </div>
    )
  }

  const messageCard = nativeChatBotMessageCardOf(message)
  if (messageCard) {
    return (
      <div ref={rowRef} data-native-chat-message-id={message.id}>
        {nativeChatMessageBotCard(messageCard, message.timestamp)}
      </div>
    )
  }

  // The card the person answered shows the receipt; the turn that tells the bot draws nothing.
  if (message.orcaNotice === 'card-answer') {
    return <div ref={rowRef} data-native-chat-message-id={message.id} />
  }

  if (message.orcaNotice === 'bot-created') {
    return (
      <div ref={rowRef} data-native-chat-message-id={message.id}>
        <NativeChatBotCreatedRow messageId={message.id} timestamp={message.timestamp} />
      </div>
    )
  }

  if (message.orcaNotice === 'took-over') {
    const goal = message.tookOver?.goal
    const divider = (
      <NativeChatTookOverRow tookOver={message.tookOver} timestamp={message.timestamp} />
    )
    if (!goal) {
      return (
        <div ref={rowRef} data-native-chat-message-id={message.id}>
          {divider}
        </div>
      )
    }
    // The projection gave it the goal as its words: the owner's message; the rest was context.
    return (
      <div className="flex flex-col gap-4">
        {divider}
        <NativeChatUserMessageRow
          message={message}
          markdown={markdown}
          prose={prose}
          rowRef={rowRef}
          onRefolded={returnToView}
          runtimeContext={runtimeContext}
          deliveryNotice={deliveryNotice}
        />
      </div>
    )
  }

  if (message.agentStart && message.from) {
    return (
      <div ref={rowRef} data-native-chat-message-id={message.id}>
        <NativeChatAgentMessageCard
          message={message}
          from={message.from}
          runtimeContext={runtimeContext}
          onRefolded={returnToView}
        />
      </div>
    )
  }

  const notice = isSystem ? nativeChatNoticeBlock(blocks) : undefined
  if (notice?.automationResult) {
    return (
      <div ref={rowRef}>
        <NativeChatAutomationResultRow
          note={notice.automationResult}
          cleared={notice.automationResultCleared === true}
        />
      </div>
    )
  }
  if (notice) {
    return (
      <div ref={rowRef}>
        {/* A subagent's last word, shown in its sheet. */}
        {isNativeChatSubagentEndingPresentation(notice.presentation) ? (
          <NativeChatSubagentEndingRow block={notice} messageId={message.id} />
        ) : (
          <NativeChatNoticeRow
            block={notice}
            messageId={message.id}
            timestamp={message.timestamp}
            agentName={agentName}
          />
        )}
      </div>
    )
  }

  if (providerFrame) {
    return (
      <div ref={rowRef}>
        <ProviderFrameRow block={providerFrame} />
      </div>
    )
  }

  if (isUser) {
    return (
      <NativeChatUserMessageRow
        message={message}
        markdown={markdown}
        prose={prose}
        rowRef={rowRef}
        onRefolded={returnToView}
        runtimeContext={runtimeContext}
        structuredAttachments={props.structuredAttachments}
        rewind={rewind}
        deliveryNotice={deliveryNotice}
      />
    )
  }

  if (isReasoning && run === undefined) {
    return (
      <div ref={rowRef}>
        <NativeChatReasoningRow
          message={message}
          turnIsWorking={activeTurnIsWorking}
          markdown={markdown}
        />
      </div>
    )
  }

  return (
    <NativeChatAssistantMessageRow
      props={props}
      content={content}
      run={run}
      rowRef={rowRef}
      scrollToTop={scrollToTop}
    />
  )
}

/** A rebuilt transcript hands every run a fresh member list; same messages, same row. */
function sameMessageRowProps(previous: MessageRowProps, next: MessageRowProps): boolean {
  const { workRun: previousRun, ...previousRest } = previous
  const { workRun: nextRun, ...nextRest } = next
  const nextProps = new Map(Object.entries(nextRest))
  return (
    Object.keys(previousRest).length === nextProps.size &&
    Object.entries(previousRest).every(
      ([key, value]) => nextProps.has(key) && Object.is(value, nextProps.get(key))
    ) &&
    previousRun?.length === nextRun?.length &&
    (previousRun ?? []).every((member, index) => member === nextRun?.[index])
  )
}
