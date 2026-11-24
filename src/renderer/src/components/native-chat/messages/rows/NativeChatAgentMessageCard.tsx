import { useMemo } from 'react'
import type { AgentDotState } from '@/components/agent/status/AgentStateDot'
import { AgentTypeIcon } from '@/components/agent/icons/agent-type-icon'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import {
  agentMessageSendersShown,
  type AgentMessageSource
} from '../../../../../../shared/agent-session/journal/agent-session-message-source'
import {
  agentMessageHeading,
  agentMessagePrimarySender,
  agentMessageCanCopy,
  agentMessageWaitingQueuedId
} from '../../../../../../shared/agent-session/view/messages/agent-message-presentation'
import { agentMessageTranscriptText } from '../../../../../../shared/agent-session/view/messages/agent-message-display-text'
import { agentMessagePreviewLine } from '../../../../../../shared/agent-session/view/messages/agent-message-preview-line'
import { agentMessageSessionWorker } from '../../../../../../shared/agent-session/view/messages/agent-message-dispatch'
import {
  sessionWorkerIsRunning,
  type OrchestrationSessionWorker
} from '../../../../../../shared/orchestration-session-workers'
import { NativeChatAgentMessageSenderNames } from '../agent-senders/NativeChatAgentMessageSenders'
import { useAgentMessageSenderView } from '../agent-senders/native-chat-agent-message-sender-view'
import {
  unnamedSenderLabel,
  useAgentMessageSenderBot,
  useAgentMessageSenderLabel
} from '../agent-senders/native-chat-agent-message-sender-label'
import { BotAvatar, CarriedBotAvatar } from '@/components/bots/BotAvatar'
import { useNativeChatVisualOwner } from '../../media/visuals/native-chat-visual-owner'
import { useNativeChatWorkers } from '../../native-chat-workers-context'
import { NativeChatMarkdown } from '../../markdown/NativeChatMarkdown'
import { NativeChatTextAttachments } from '../../media/text/NativeChatTextAttachments'
import { NativeChatCodeBlock } from '../../markdown/code/NativeChatCodeBlock'
import { NativeChatMessageTimestamp } from './NativeChatMessageTimestamp'
import { NativeChatImageAttachments } from '../../media/images/NativeChatImageAttachments'
import type { NativeChatEventBadge } from '../events/NativeChatEventRow'
import { NativeChatAgentMessageRow } from './NativeChatAgentMessageRow'
import { ItemChip } from '../../bot-items/NativeChatBotItemNoteRow'
import { agentMessageRowLead } from './agent-message-row-lead'
import { NativeChatWaitingAgentMailActions } from '../../queue/NativeChatWaitingAgentMailActions'

/** The one word drawn before the name for a start, a hand-off or a task; a plain message draws none. */
function kindWord(
  from: AgentMessageSource,
  message: NativeChatMessage,
  t: Translate = translate
): string | null {
  switch (agentMessageHeading(from, message)) {
    case 'started':
    case 'started-agent':
      return t('components.native-chat.agentMessage.kind.started', 'Started')
    case 'reopened-worker':
      return t('components.native-chat.agentMessage.kind.reopened', 'Reopened')
    case 'followed-up-worker':
      return t('components.native-chat.agentMessage.kind.followedUp', 'Follow-up')
    case 'handed-off':
      return t('components.native-chat.agentMessage.kind.handedOff', 'Handed off')
    case 'task':
      return t('components.native-chat.agentMessage.kind.task', 'Task')
    case 'worker':
    case 'coordinator':
    case 'generic':
      return null
  }
}

type AgentMessageCardProps = {
  message: NativeChatMessage
  from: AgentMessageSource
  runtimeContext?: RuntimeFileOperationArgs | null
  textAttachmentContent?: string
  onRefolded: () => void
}

/** A message between agents (a start, a task, a worker's update) as one line: the sender's agent mark
 *  with its worker's state, its name and the message's first line, with the whole message opening below. */
export function NativeChatAgentMessageCard({
  message,
  from,
  runtimeContext,
  textAttachmentContent,
  onRefolded
}: AgentMessageCardProps): React.JSX.Element {
  const t = useTranslate()
  const owner = useNativeChatVisualOwner()
  const worktreeId = owner?.worktreeId ?? runtimeContext?.worktreeId ?? null
  const target = owner?.target ?? runtimeContext?.target
  // A sender's status change redraws the row; the body's text and first line are read once per body.
  const text = useMemo(
    () => agentMessageTranscriptText(message.blocks, from, message.shortened),
    [message.blocks, from, message.shortened]
  )
  const worker = agentMessageSessionWorker(message, useNativeChatWorkers())
  const sender = agentMessagePrimarySender(from)
  const dispatchId = message.agentStartDispatchId ?? worker?.dispatchId
  const { shown, more } = agentMessageSendersShown(from)
  // Mail from several senders resolves each by its own address, as the sender names do.
  const senderDispatchId = shown.length > 1 ? undefined : dispatchId
  const canCopy = agentMessageCanCopy(text)
  const merged = message.mergedEvents ?? []
  const hasImages = message.blocks.some((block) => block.type === 'image-ref')
  const expandable = canCopy || merged.length > 0 || hasImages
  const words = agentMessageRowLead(from, message, t)
  const items = message.agentStartItems ?? []
  const forItems = t('components.native-chat.agentMessage.row.forItems', 'for')
  const preview = useMemo(() => agentMessagePreviewLine(text), [text])
  const senderName = useAgentMessageSenderLabel(
    sender ?? NO_SENDER,
    worktreeId,
    target,
    senderDispatchId
  )
  const view = useAgentMessageSenderView(sender, worktreeId, target, dispatchId)
  // Not taken by the agent yet: dimmed, with no time, until its delivered row replaces it in place.
  const waiting = message.queued === true
  const waitingId = agentMessageWaitingQueuedId(message)
  return (
    <NativeChatAgentMessageRow
      className={waiting ? 'w-full opacity-70' : 'w-full'}
      icon={
        <AgentMessageAvatar
          sender={sender}
          dispatchId={dispatchId}
          agentType={worker?.agent ?? view.agentType}
          worktreeId={worktreeId}
          target={target}
        />
      }
      badge={agentMessageBadge(worker, view.dot)}
      kind={kindWord(from, message, t)}
      lead={words}
      spokenNames={`${sender ? senderName : unnamedSenderLabel(t)}${shown.length + more > 1 ? ` +${shown.length + more - 1}` : ''}${items.length > 0 ? ` ${forItems} ${items.map((item) => item.title).join(', ')}` : ''}`}
      names={(spoken) => (
        <>
          <NativeChatAgentMessageSenderNames
            from={from}
            shown={shown}
            more={more}
            chatWorktreeId={worktreeId}
            target={target}
            dispatchId={dispatchId}
            spoken={spoken}
          />
          {/* A start joined with its item link names the items it was for. */}
          {items.length > 0 ? (
            <>
              <span aria-hidden={!spoken || undefined} className="shrink-0 font-normal">
                {forItems}
              </span>
              {items.map((item) => (
                <ItemChip key={item.uid} item={item} />
              ))}
            </>
          ) : null}
        </>
      )}
      preview={preview.line}
      more={
        preview.more ||
        merged.length > 0 ||
        hasImages ||
        textAttachmentContent !== undefined ||
        message.shortened === true
      }
      timestamp={waiting ? null : message.timestamp}
      spokenState={
        waiting
          ? t('components.native-chat.agentMessage.row.notSentYet', 'not sent yet')
          : undefined
      }
      action={
        waitingId ? <NativeChatWaitingAgentMailActions queuedMessageId={waitingId} /> : undefined
      }
      disclosureKey={`agent-message:${message.queuedMessageId ?? message.id}`}
      onOpenChange={(open) => {
        if (!open) {
          requestAnimationFrame(onRefolded)
        }
      }}
      details={
        expandable ? (
          <>
            <NativeChatImageAttachments
              blocks={message.blocks}
              runtimeContext={runtimeContext}
              enablePreview={runtimeContext !== undefined}
            />
            <NativeChatTextAttachments
              content={textAttachmentContent ?? text}
              structured={textAttachmentContent !== undefined}
              runtimeContext={runtimeContext}
              renderText={() => (
                <NativeChatMarkdown
                  rowKey={message.id}
                  content={text}
                  variant="document"
                  className="text-sm"
                  renderCodeBlock={NativeChatCodeBlock}
                />
              )}
            />
            {merged.map((earlier) => (
              <MergedAgentMessage key={earlier.id} message={earlier} newerLead={words} />
            ))}
          </>
        ) : null
      }
    />
  )
}

/** An earlier message about the same Dispatch, under the newer row it merged into: its time (and
 *  its lead when it differs, as "Started", with the items its start was for), then its words. */
function MergedAgentMessage({
  message,
  newerLead
}: {
  message: NativeChatMessage
  newerLead: string
}): React.JSX.Element {
  const t = useTranslate()
  const from = message.from
  const words = from ? agentMessageRowLead(from, message, t) : null
  const text = agentMessageTranscriptText(message.blocks, from, message.shortened)
  return (
    <>
      <p className="flex min-w-0 items-center gap-1 text-xs text-chat-foreground-faint">
        {words && words !== newerLead ? <span>{words}</span> : null}
        {message.agentStartItems?.length ? (
          <>
            <span>{t('components.native-chat.agentMessage.row.forItems', 'for')}</span>
            {message.agentStartItems.map((item) => (
              <ItemChip key={item.uid} item={item} />
            ))}
          </>
        ) : null}
        <NativeChatMessageTimestamp timestamp={message.timestamp} />
      </p>
      {text.trim() ? (
        <NativeChatMarkdown
          rowKey={message.id}
          content={text}
          variant="document"
          className="text-sm"
          renderCodeBlock={NativeChatCodeBlock}
        />
      ) : null}
    </>
  )
}

/** Stands in so the name hook runs in every render; its answer is unused without a sender. */
const NO_SENDER: AgentMessageSource['senders'][number] = {
  party: { address: '', terminalHandle: null, orcaSessionId: null },
  name: null
}

const BOT_TILE = 'size-3.5 rounded-sm border-0 text-3xs'

function AgentMessageAvatar({
  dispatchId,
  sender,
  agentType,
  worktreeId,
  target
}: {
  dispatchId?: string
  sender: AgentMessageSource['senders'][number] | undefined
  agentType: ReturnType<typeof useAgentMessageSenderView>['agentType']
  worktreeId: string | null
  target?: RuntimeClientTarget
}): React.JSX.Element {
  const bot = useAgentMessageSenderBot(sender, worktreeId, target, dispatchId)
  return bot ? (
    <BotAvatar bot={bot} className={BOT_TILE} />
  ) : sender?.bot && sender.host ? (
    // A paired computer's agent, which this computer's catalog doesn't hold.
    <CarriedBotAvatar
      name={sender.name ?? ''}
      avatar={sender.botAvatar ?? null}
      className={BOT_TILE}
    />
  ) : (
    <AgentTypeIcon agentType={agentType} size={14} />
  )
}

/** The worker's Dispatch as its host records it decides the badge, so a restarted worker never
 *  un-fails an old row; a sender the chat didn't start falls back to its live state, never to failed. */
function agentMessageBadge(
  worker: OrchestrationSessionWorker | undefined,
  liveDot: AgentDotState | null | undefined
): NativeChatEventBadge | null {
  if (worker) {
    return sessionWorkerIsRunning(worker) ? 'running' : worker.state === 'failed' ? 'failed' : null
  }
  return liveDot === 'working' ? 'running' : null
}
