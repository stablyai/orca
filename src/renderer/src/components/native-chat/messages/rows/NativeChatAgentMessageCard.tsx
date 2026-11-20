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
  agentMessageCanCopy
} from '../../../../../../shared/agent-session/view/messages/agent-message-presentation'
import { agentMessageTranscriptText } from '../../../../../../shared/agent-session/view/messages/agent-message-display-text'
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
import { usePluginMessageSender } from '../agent-senders/native-chat-plugin-message-sender'
import { PluginContributionIcon } from '@/components/plugins/PluginContributionIcon'
import { useNativeChatVisualOwner } from '../../media/visuals/native-chat-visual-owner'
import { useNativeChatWorkers } from '../../native-chat-workers-context'
import { NativeChatMarkdown } from '../../markdown/NativeChatMarkdown'
import { NativeChatTextAttachments } from '../../media/text/NativeChatTextAttachments'
import { NativeChatCodeBlock } from '../../markdown/code/NativeChatCodeBlock'
import { NativeChatMessageTimestamp } from './NativeChatMessageTimestamp'
import { NativeChatImageAttachments } from '../../media/images/NativeChatImageAttachments'
import { NativeChatEventRow, type NativeChatEventBadge } from '../events/NativeChatEventRow'

function lead(
  from: AgentMessageSource,
  message: NativeChatMessage,
  t: Translate = translate
): string {
  switch (agentMessageHeading(from, message)) {
    case 'started':
    case 'started-agent':
      return t('components.native-chat.agentMessage.row.started', 'Started')
    case 'reopened-worker':
      return t('components.native-chat.agentMessage.row.reopened', 'Reopened')
    case 'followed-up-worker':
      return t('components.native-chat.agentMessage.row.followedUp', 'Sent follow-up to')
    case 'handed-off':
      return t('components.native-chat.agentMessage.row.handedOff', 'Handed off to')
    case 'task':
      return t('components.native-chat.agentMessage.row.task', 'Task from')
    case 'worker':
      return t('components.native-chat.agentMessage.row.update', 'Update from')
    case 'coordinator':
    case 'generic':
      return t('components.native-chat.agentMessage.row.message', 'Message from')
  }
}

type AgentMessageCardProps = {
  message: NativeChatMessage
  from: AgentMessageSource
  runtimeContext?: RuntimeFileOperationArgs | null
  textAttachmentContent?: string
  onRefolded: () => void
}

/** A message between agents (a start, a task, a worker's update) as one status row: the sender's
 *  agent mark with its worker's state, "Update from <name>", and the message itself opening below. */
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
  const text = agentMessageTranscriptText(message.blocks, from, message.shortened)
  const worker = agentMessageSessionWorker(message, useNativeChatWorkers())
  const sender = agentMessagePrimarySender(from)
  const dispatchId = message.agentStartDispatchId ?? worker?.dispatchId
  const { shown, more } = agentMessageSendersShown(from)
  const canCopy = agentMessageCanCopy(text)
  const merged = message.mergedEvents ?? []
  const expandable =
    canCopy || merged.length > 0 || message.blocks.some((block) => block.type === 'image-ref')
  const words = lead(from, message, t)
  const senderName = useAgentMessageSenderLabel(sender ?? NO_SENDER, worktreeId, target, dispatchId)
  const view = useAgentMessageSenderView(sender, worktreeId, target, dispatchId)
  return (
    <NativeChatEventRow
      className="w-full"
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
      label={expandable ? `${words} ${sender ? senderName : unnamedSenderLabel(t)}` : undefined}
      timestamp={message.timestamp}
      disclosureKey={`agent-message:${message.id}`}
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
    >
      {/* One sender cuts short in its chip on one line; several may wrap to a second line. */}
      <span
        className={`flex min-w-0 items-center gap-x-1 whitespace-nowrap ${shown.length > 1 ? 'flex-wrap' : ''}`}
      >
        <span className="shrink-0">{words}</span>
        {shown.length === 0 ? (
          <span className="min-w-0 truncate">{unnamedSenderLabel(t)}</span>
        ) : (
          <NativeChatAgentMessageSenderNames
            from={from}
            shown={shown}
            chatWorktreeId={worktreeId}
            target={target}
            dispatchId={dispatchId}
          />
        )}
        {more > 0 ? <span className="shrink-0">+{more}</span> : null}
      </span>
    </NativeChatEventRow>
  )
}

/** An earlier message about the same Dispatch, under the newer row it merged into: its time (and
 *  its lead when it differs, as "Started"), then its words. */
function MergedAgentMessage({
  message,
  newerLead
}: {
  message: NativeChatMessage
  newerLead: string
}): React.JSX.Element {
  const t = useTranslate()
  const from = message.from
  const words = from ? lead(from, message, t) : null
  const text = agentMessageTranscriptText(message.blocks, from, message.shortened)
  return (
    <>
      <p className="flex items-center gap-1 text-xs text-chat-foreground-faint">
        {words && words !== newerLead ? <span>{words}</span> : null}
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
  const plugin = usePluginMessageSender(sender?.party.address)
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
    <PluginContributionIcon
      url={plugin?.iconUrl}
      className="size-3.5 rounded-sm"
      fallback={<AgentTypeIcon agentType={agentType} size={14} />}
    />
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
