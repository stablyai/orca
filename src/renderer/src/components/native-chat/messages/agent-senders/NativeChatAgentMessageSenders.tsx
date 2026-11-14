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
  compact = false,
  inline = false
}: {
  from: AgentMessageSource
  chatWorktreeId: string | null
  target?: RuntimeClientTarget
  compact?: boolean
  queued?: boolean
  /** A queued row's one-line sender: no "From", muted and truncating after the message. */
  inline?: boolean
  dispatchId?: string
}): React.JSX.Element {
  const t = useTranslate()
  const { shown, more } = agentMessageSendersShown(from)
  const owner = useNativeChatVisualOwner()
  const worktreeId = owner?.worktreeId ?? chatWorktreeId
  return (
    <div
      className={`flex min-w-0 max-w-full ${compact || inline ? 'flex-nowrap' : 'flex-wrap'} items-center ${inline ? 'text-xs text-muted-foreground' : queued ? 'text-xs text-chat-foreground-faint' : compact ? 'text-sm text-foreground' : '-ml-2.5 text-sm text-foreground'}`}
    >
      {inline ? null : (
        <span>{queued ? t('components.native-chat.queuedMessages.fromSender', 'From') : null}</span>
      )}
      {shown.length === 0 ? (
        <span
          className={
            inline
              ? 'min-w-0 truncate'
              : compact
                ? 'min-w-0 truncate px-1.5'
                : queued
                  ? 'px-2'
                  : 'px-2.5'
          }
        >
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
            queued={queued || inline}
            compact={compact}
            inline={inline}
          />
          {/* Outside compact, pulled back over the name's padding so it reads "A, B". */}
          {index < shown.length - 1 ? (
            <span
              aria-hidden
              className={compact ? undefined : inline ? 'mr-1' : queued ? '-ml-2' : '-ml-2.5'}
            >
              ,
            </span>
          ) : null}
        </Fragment>
      ))}
      {more > 0 ? <span className="shrink-0">+{more}</span> : null}
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
  compact,
  inline = false
}: {
  dispatchId?: string
  from: AgentMessageSource
  sender: AgentMessageSender
  chatWorktreeId: string | null
  target?: RuntimeClientTarget
  queued: boolean
  compact: boolean
  inline?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const label = useAgentMessageSenderLabel(sender, chatWorktreeId, target, dispatchId)
  const opens = useAgentMessageSenderOpens(sender, chatWorktreeId, target, dispatchId)
  if (!opens || !chatWorktreeId) {
    return (
      <span
        className={`min-w-0 truncate ${inline ? 'max-w-full' : compact ? 'max-w-fit flex-1 basis-0 px-1.5' : queued ? 'max-w-full px-2' : 'max-w-full px-2.5'}`}
        title={label}
      >
        {label}
      </span>
    )
  }
  const open = (): void =>
    void openAgentMessageSender(from, sender, chatWorktreeId, target, dispatchId, label)
  if (inline) {
    // Muted text in a one-line queued row, not a padded button.
    return (
      <button
        type="button"
        title={label}
        onClick={open}
        className="min-w-0 max-w-full truncate rounded-sm text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {label}
      </button>
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
      onClick={open}
    >
      <span className="min-w-0 truncate">{label}</span>
      {!queued ? <ArrowUpRight className="size-3" aria-hidden /> : null}
    </Button>
  )
}
