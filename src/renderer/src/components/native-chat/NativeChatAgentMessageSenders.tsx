import { Fragment } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { openAgentMessageSender } from '@/lib/open-agent-message-sender'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import { useNativeChatVisualOwner } from './native-chat-visual-owner'
import {
  agentMessageSendersShown,
  type AgentMessageSender,
  type AgentMessageSource
} from '../../../../shared/agent-session-message-source'
import {
  unnamedSenderLabel,
  useAgentMessageSenderLabel
} from './native-chat-agent-message-sender-label'

/** "Message from <name>" over another agent's message, or "From <name>" on its queued card; each
 *  name opens that agent. Plain text where the transcript has no chat to resolve the sender
 *  against, and for a sender that runs on another host. */
export function NativeChatAgentMessageSenders({
  from,
  chatWorktreeId,
  queued = false
}: {
  from: AgentMessageSource
  chatWorktreeId: string | null
  queued?: boolean
}): React.JSX.Element {
  const { shown, more } = agentMessageSendersShown(from)
  const owner = useNativeChatVisualOwner()
  const worktreeId = owner?.worktreeId ?? chatWorktreeId
  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-center text-xs text-muted-foreground">
      <span>
        {queued
          ? translate('components.native-chat.queuedMessages.fromSender', 'From')
          : translate('components.native-chat.agentMessage.messageFrom', 'Message from')}
      </span>
      {shown.length === 0 ? <span className="px-2">{unnamedSenderLabel()}</span> : null}
      {shown.map((sender, index) => (
        // Fragment keys: one sender's name and the separator after it.
        <Fragment key={sender.party.address}>
          <SenderName
            from={from}
            sender={sender}
            chatWorktreeId={worktreeId}
            target={owner?.target}
          />
          {/* Pulled back over the name's padding, so it reads "A, B". */}
          {index < shown.length - 1 ? (
            <span aria-hidden className="-ml-2">
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
  target
}: {
  from: AgentMessageSource
  sender: AgentMessageSender
  chatWorktreeId: string | null
  target?: RuntimeClientTarget
}): React.JSX.Element {
  const label = useAgentMessageSenderLabel(sender, chatWorktreeId, target)
  if (!chatWorktreeId || !opensFromHere(sender)) {
    return (
      <span className="max-w-48 truncate px-2" title={label}>
        {label}
      </span>
    )
  }
  return (
    <Button
      type="button"
      variant="link"
      size="xs"
      title={label}
      onClick={() =>
        void (target
          ? openAgentMessageSender(from, sender, chatWorktreeId, target)
          : openAgentMessageSender(from, sender, chatWorktreeId))
      }
    >
      <span className="max-w-48 truncate">{label}</span>
    </Button>
  )
}

/** A federated sender (`dispatch:<id>`) runs on another host, which this chat's host cannot open. */
function opensFromHere(sender: AgentMessageSender): boolean {
  return !sender.party.address.startsWith('dispatch:')
}
