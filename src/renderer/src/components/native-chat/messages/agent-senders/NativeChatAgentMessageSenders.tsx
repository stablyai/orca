import { Fragment } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { openAgentMessageSender } from '@/lib/agent-session/open/open-agent-message-sender'
import { useNativeChatVisualOwner } from '../../media/visuals/native-chat-visual-owner'
import { agentMessageSendersShown } from '../../../../../../shared/agent-session/agent-session-message-source'
import type {
  AgentMessageSender,
  AgentMessageSource
} from '../../../../../../shared/agent-session/agent-session-message-source'
import {
  unnamedSenderLabel,
  useAgentMessageSenderLabel
} from './native-chat-agent-message-sender-label'
import { useAgentMessageSenderOpens } from './native-chat-agent-message-sender-view'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'

/** Link a sender only where its one resolution can open something; otherwise a plain name. */
export function NativeChatAgentMessageSenders({
  from,
  chatWorktreeId,
  target,
  queued = false,
  dispatchId,
  compact = false
}: {
  from: AgentMessageSource
  chatWorktreeId: string | null
  target?: RuntimeClientTarget
  compact?: boolean
  queued?: boolean
  dispatchId?: string
}): React.JSX.Element {
  const t = useTranslate()
  const { shown, more } = agentMessageSendersShown(from)
  const owner = useNativeChatVisualOwner()
  const worktreeId = owner?.worktreeId ?? chatWorktreeId
  return (
    <div
      className={`flex min-w-0 max-w-full ${compact ? 'flex-nowrap' : 'flex-wrap'} items-center ${queued ? 'text-xs text-chat-foreground-faint' : compact ? 'text-sm text-foreground' : '-ml-2.5 text-sm text-foreground'}`}
    >
      <span>{queued ? t('components.native-chat.queuedMessages.fromSender', 'From') : null}</span>
      {shown.length === 0 ? (
        <span className={compact ? 'min-w-0 truncate px-1.5' : queued ? 'px-2' : 'px-2.5'}>
          {unnamedSenderLabel(t)}
        </span>
      ) : null}
      {shown.map((sender, index) => (
        <Fragment key={sender.party.address}>
          <SenderName
            dispatchId={dispatchId}
            from={from}
            sender={sender}
            chatWorktreeId={worktreeId}
            target={owner?.target ?? target}
            queued={queued}
            compact={compact}
          />
          {/* Outside compact, pulled back over the name's padding so it reads "A, B". */}
          {index < shown.length - 1 ? (
            <span aria-hidden className={compact ? undefined : queued ? '-ml-2' : '-ml-2.5'}>
              ,
            </span>
          ) : null}
        </Fragment>
      ))}
      {more > 0 ? <span className="shrink-0">+{more}</span> : null}
      {from.link ? (
        <span className="ml-2 max-w-64 truncate text-xs text-muted-foreground">
          · {t('components.sessionLink.link', 'Link')}: {from.link.title}
        </span>
      ) : null}
    </div>
  )
}

function SenderName({
  dispatchId,
  from,
  sender,
  chatWorktreeId,
  target,
  queued,
  compact
}: {
  dispatchId?: string
  from: AgentMessageSource
  sender: AgentMessageSender
  chatWorktreeId: string | null
  target?: RuntimeClientTarget
  queued: boolean
  compact: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const label = useAgentMessageSenderLabel(sender, chatWorktreeId, target, dispatchId)
  const opens = useAgentMessageSenderOpens(sender, chatWorktreeId, target, dispatchId)
  if (!opens || !chatWorktreeId) {
    return (
      <span
        className={`min-w-0 truncate ${compact ? 'max-w-fit flex-1 basis-0 px-1.5' : queued ? 'max-w-full px-2' : 'max-w-full px-2.5'}`}
        title={label}
      >
        {label}
      </span>
    )
  }
  return (
    <Button
      type="button"
      variant={queued ? 'link' : 'ghost'}
      size={compact ? 'inlineChip' : queued ? 'xs' : 'sm'}
      className={`min-w-0 ${compact ? 'max-w-fit flex-1 basis-0' : 'max-w-full'}`}
      title={
        queued || compact
          ? label
          : t('components.native-chat.agentMessage.goToAgent', 'Go to agent')
      }
      onClick={() =>
        void openAgentMessageSender(from, sender, chatWorktreeId, target, dispatchId, label)
      }
    >
      <span className="min-w-0 truncate">{label}</span>
      {!queued ? <ArrowUpRight className="size-3" aria-hidden /> : null}
    </Button>
  )
}
