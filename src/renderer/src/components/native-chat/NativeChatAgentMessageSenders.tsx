import { Fragment } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { openAgentMessageSender } from '@/lib/open-agent-message-sender'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { agentMessageSenderCanOpen } from '../../../../shared/agent-session/agent-message-presentation'
import { useNativeChatVisualOwner } from './native-chat-visual-owner'
import {
  agentMessageSendersShown,
  type AgentMessageSender,
  type AgentMessageSource
} from '../../../../shared/agent-session/agent-session-message-source'
import {
  unnamedSenderLabel,
  useAgentMessageSenderLabel
} from './native-chat-agent-message-sender-label'

/** Open resolvable local senders; use plain names when chat context is absent or the sender belongs to another host. */
export function NativeChatAgentMessageSenders({
  from,
  chatWorktreeId,
  target,
  queued = false
}: {
  from: AgentMessageSource
  chatWorktreeId: string | null
  target?: RuntimeClientTarget
  queued?: boolean
}): React.JSX.Element {
  const { shown, more } = agentMessageSendersShown(from)
  const owner = useNativeChatVisualOwner()
  const worktreeId = owner?.worktreeId ?? chatWorktreeId
  return (
    <div
      className={`flex min-w-0 max-w-full flex-wrap items-center ${queued ? 'text-xs text-chat-foreground-faint' : '-ml-2.5 text-sm text-foreground'}`}
    >
      <span>
        {queued ? translate('components.native-chat.queuedMessages.fromSender', 'From') : null}
      </span>
      {shown.length === 0 ? (
        <span className={queued ? 'px-2' : 'px-2.5'}>{unnamedSenderLabel()}</span>
      ) : null}
      {shown.map((sender, index) => (
        <Fragment key={sender.party.address}>
          <SenderName
            from={from}
            sender={sender}
            chatWorktreeId={worktreeId}
            target={owner?.target ?? target}
            queued={queued}
          />
          {/* Pulled back over the name's padding, so it reads "A, B". */}
          {index < shown.length - 1 ? (
            <span aria-hidden className={queued ? '-ml-2' : '-ml-2.5'}>
              ,
            </span>
          ) : null}
        </Fragment>
      ))}
      {more > 0 ? <span>+{more}</span> : null}
    </div>
  )
}

function SenderName({
  from,
  sender,
  chatWorktreeId,
  target,
  queued
}: {
  from: AgentMessageSource
  sender: AgentMessageSender
  chatWorktreeId: string | null
  target?: RuntimeClientTarget
  queued: boolean
}): React.JSX.Element {
  const label = useAgentMessageSenderLabel(sender, chatWorktreeId, target)
  if (!agentMessageSenderCanOpen(sender, Boolean(chatWorktreeId)) || !chatWorktreeId) {
    return (
      <span className={`max-w-48 truncate ${queued ? 'px-2' : 'px-2.5'}`} title={label}>
        {label}
      </span>
    )
  }
  return (
    <Button
      type="button"
      variant={queued ? 'link' : 'ghost'}
      size={queued ? 'xs' : 'sm'}
      title={
        queued ? label : translate('components.native-chat.agentMessage.goToAgent', 'Go to agent')
      }
      onClick={() =>
        void (target
          ? openAgentMessageSender(from, sender, chatWorktreeId, target)
          : openAgentMessageSender(from, sender, chatWorktreeId))
      }
    >
      <span className="max-w-48 truncate">{label}</span>
      {!queued ? <ArrowUpRight className="size-3" aria-hidden /> : null}
    </Button>
  )
}
