import { useId } from 'react'
import { ChevronDown } from 'lucide-react'
import { AgentStateDot } from '@/components/AgentStateDot'
import { AgentTypeIcon } from '@/components/agent/icons/agent-type-icon'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { AgentMessageSource } from '../../../../../../shared/agent-session/agent-session-message-source'
import {
  agentMessageHeading,
  agentMessagePrimarySender,
  agentMessageCanCopy
} from '../../../../../../shared/agent-session/agent-message-presentation'
import { agentMessageTranscriptText } from '../../../../../../shared/agent-session/agent-message-display-text'
import { NativeChatAgentMessageSenders } from '../agent-senders/NativeChatAgentMessageSenders'
import { useAgentMessageSenderView } from '../agent-senders/native-chat-agent-message-sender-view'
import { useNativeChatVisualOwner } from '../../media/visuals/native-chat-visual-owner'
import { useNativeChatDisclosure } from '../disclosure/native-chat-disclosure-store'
import { NativeChatExpandable } from '../disclosure/NativeChatExpandable'
import { NativeChatMarkdown } from '../../markdown/NativeChatMarkdown'
import { NativeChatTextAttachments } from '../../media/text/NativeChatTextAttachments'
import { NativeChatCodeBlock } from '../../markdown/code/NativeChatCodeBlock'
import { NativeChatCopyButton } from '../actions/NativeChatCopyButton'
import { NativeChatMessageTimestamp } from './NativeChatMessageTimestamp'
import { NativeChatImageAttachments } from '../../media/images/NativeChatImageAttachments'

function heading(
  from: AgentMessageSource,
  message: NativeChatMessage,
  t: Translate = translate
): string {
  switch (agentMessageHeading(from, message)) {
    case 'started':
      return t('components.native-chat.agentMessage.startedWorker', 'Started worker')
    case 'handed-off':
      return t('components.native-chat.agentMessage.handedOffToAgent', 'Handed off to agent')
    case 'started-agent':
      return t('components.native-chat.agentMessage.startedAgent', 'Started agent')
    case 'task':
      return t('components.native-chat.agentMessage.taskFromCoordinator', 'Task from coordinator')
    case 'coordinator':
      return t(
        'components.native-chat.agentMessage.messageFromCoordinator',
        'Message from coordinator'
      )
    case 'worker':
      return t('components.native-chat.agentMessage.updateFromWorker', 'Update from worker')
    case 'generic':
      return t('components.native-chat.agentMessage.messageFrom', 'Message from')
  }
}

type AgentMessageCardProps = {
  message: NativeChatMessage
  from: AgentMessageSource
  runtimeContext?: RuntimeFileOperationArgs | null
  textAttachmentContent?: string
  onRefolded: () => void
}

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
  const disclosure = useNativeChatDisclosure(`agent-message:${message.id}`, false)
  const labelId = useId()
  const bodyId = useId()
  const expandable =
    agentMessageCanCopy(text) || message.blocks.some((block) => block.type === 'image-ref')
  const toggle = () => {
    disclosure.setOpen(!disclosure.open)
    if (disclosure.open) {
      requestAnimationFrame(onRefolded)
    }
  }
  return (
    <div className="group @container w-full rounded-xl border border-border bg-card text-sm text-card-foreground">
      <div
        className="relative flex min-w-0 items-center gap-2 px-3 py-1.5"
        data-state={disclosure.open ? 'open' : 'closed'}
      >
        {expandable ? (
          <button
            type="button"
            aria-labelledby={labelId}
            aria-controls={bodyId}
            aria-expanded={disclosure.open}
            onClick={toggle}
            className="absolute inset-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        ) : null}
        <div className="pointer-events-none">
          <AgentMessageAvatar
            sender={agentMessagePrimarySender(from)}
            dispatchId={message.agentStartDispatchId}
            worktreeId={worktreeId}
            target={target}
          />
        </div>
        <span
          id={labelId}
          className="pointer-events-none max-w-1/3 shrink-0 truncate text-xs text-muted-foreground"
        >
          {heading(from, message, t)}
        </span>
        <div className="pointer-events-none relative min-w-0 flex-1 [&_button]:pointer-events-auto">
          <NativeChatAgentMessageSenders
            compact
            dispatchId={message.agentStartDispatchId}
            from={from}
            chatWorktreeId={worktreeId}
            target={target}
          />
        </div>
        {agentMessageCanCopy(text) ? (
          <NativeChatCopyButton
            text={text}
            className="relative transition-opacity can-hover:pointer-events-none can-hover:opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 [.group:has(:focus-visible)_&]:pointer-events-auto [.group:has(:focus-visible)_&]:opacity-100"
          />
        ) : null}
        <div className={cn('pointer-events-none shrink-0', expandable && 'hidden @sm:block')}>
          <NativeChatMessageTimestamp
            timestamp={message.timestamp}
            className="text-muted-foreground"
          />
        </div>
        {expandable ? (
          <ChevronDown
            aria-hidden
            className={cn(
              'pointer-events-none size-3.5 shrink-0 text-muted-foreground',
              disclosure.open && 'rotate-180'
            )}
          />
        ) : null}
      </div>
      <NativeChatExpandable open={expandable && disclosure.open}>
        <div id={bodyId} className="space-y-2 px-3 pb-3">
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
          <NativeChatMessageTimestamp
            timestamp={message.timestamp}
            className="text-muted-foreground @sm:hidden"
          />
        </div>
      </NativeChatExpandable>
    </div>
  )
}

function AgentMessageAvatar({
  dispatchId,
  sender,
  worktreeId,
  target
}: {
  dispatchId?: string
  sender: AgentMessageSource['senders'][number] | undefined
  worktreeId: string | null
  target?: RuntimeClientTarget
}): React.JSX.Element {
  const view = useAgentMessageSenderView(sender, worktreeId, target, dispatchId)
  return (
    <div className="relative flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-muted">
      <AgentTypeIcon agentType={view.agentType} size={16} />
      {view.dot ? (
        // Flex square: the chat line box would stretch a shrink-wrapped badge into a pill.
        <span className="absolute -right-0.5 -bottom-0.5 flex size-3.5 items-center justify-center rounded-full border border-border bg-card">
          <AgentStateDot state={view.dot} size="md" progress={view.progress} />
        </span>
      ) : null}
    </div>
  )
}
