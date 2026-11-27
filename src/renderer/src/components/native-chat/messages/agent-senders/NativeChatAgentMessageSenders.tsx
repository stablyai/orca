import { Fragment } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { WorktreeHostContextBadge } from '@/components/sidebar/workspace-card/host/WorktreeHostContextBadge'
import { useTranslate } from '@/i18n/use-translate'
import { openAgentMessageSender } from '@/lib/agent-session/open/open-agent-message-sender'
import { useNativeChatVisualOwner } from '../../media/visuals/native-chat-visual-owner'
import {
  NATIVE_CHAT_INLINE_CHIP,
  NATIVE_CHAT_INLINE_NAME,
  NATIVE_CHAT_READABLE_SHARE
} from '../events/native-chat-inline-chip'
import { agentMessageSendersShown } from '../../../../../../shared/agent-session/journal/agent-session-message-source'
import type {
  AgentMessageSender,
  AgentMessageSource
} from '../../../../../../shared/agent-session/journal/agent-session-message-source'
import {
  unnamedSenderLabel,
  useAgentMessageSenderName
} from './native-chat-agent-message-sender-label'
import { useAgentMessageSenderOpens } from './native-chat-agent-message-sender-view'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

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
          {sender.host ? (
            // The paired computer it came from, as the sidebar marks a remote bot.
            <WorktreeHostContextBadge label={sender.host} className="shrink-0" />
          ) : null}
          {/* Outside compact, pulled back over the name's padding so it reads "A, B". */}
          {index < shown.length - 1 ? (
            <span aria-hidden className={compact ? undefined : queued ? '-ml-2' : '-ml-2.5'}>
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
  const name = useAgentMessageSenderName(sender, chatWorktreeId, target, dispatchId)
  const label = name ?? unnamedSenderLabel(t)
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
        void openAgentMessageSender(from, sender, chatWorktreeId, target, dispatchId, name)
      }
    >
      <span className="min-w-0 truncate">{label}</span>
      {!queued ? <ArrowUpRight className="size-3" aria-hidden /> : null}
    </Button>
  )
}

/** An agent message row's first sender name as plain words, then +N for the rest; a name this chat
 *  can open is a button that opens it, underlined on hover. `spoken` false leaves plain names to
 *  the row button's own words. */
export function NativeChatAgentMessageSenderNames({
  from,
  shown,
  more,
  chatWorktreeId,
  target,
  dispatchId,
  spoken,
  name,
  label,
  title
}: {
  from: AgentMessageSource
  shown: readonly AgentMessageSender[]
  more: number
  chatWorktreeId: string | null
  target?: RuntimeClientTarget
  dispatchId?: string
  spoken: boolean
  name: string | null
  label: string
  /** The name where it stands alone on hover; a recipient's reads "an Eule" in German. */
  title: string
}): React.JSX.Element {
  // The message's Dispatch is its one sender's; mail from several opens its first by its own address.
  const senderDispatchId = shown.length > 1 ? undefined : dispatchId
  // One line has room for one name: the rest count as +N.
  const first = shown[0]
  const others = Math.max(shown.length - 1, 0) + more
  return (
    <>
      {shown.length === 0 ? (
        <span aria-hidden={!spoken || undefined} className={NATIVE_CHAT_READABLE_SHARE}>
          {label}
        </span>
      ) : null}
      {first ? (
        <>
          <RowSenderName
            from={from}
            sender={first}
            chatWorktreeId={chatWorktreeId}
            target={target}
            dispatchId={senderDispatchId}
            spoken={spoken}
            name={name}
            label={label}
            title={title}
          />
          {first.host ? (
            <WorktreeHostContextBadge label={first.host} className="inline-flex shrink-0" />
          ) : null}
        </>
      ) : null}
      {others > 0 ? (
        <span aria-hidden={!spoken || undefined} className="shrink-0 font-normal">
          +{others}
        </span>
      ) : null}
    </>
  )
}

function RowSenderName({
  from,
  sender,
  chatWorktreeId,
  target,
  dispatchId,
  spoken,
  name,
  label,
  title
}: {
  from: AgentMessageSource
  sender: AgentMessageSender
  chatWorktreeId: string | null
  target?: RuntimeClientTarget
  dispatchId?: string
  spoken: boolean
  name: string | null
  label: string
  /** The name where it stands alone on hover; a recipient's reads "an Eule" in German. */
  title: string
}): React.JSX.Element {
  const t = useTranslate()
  const opens = useAgentMessageSenderOpens(sender, chatWorktreeId, target, dispatchId)
  if (!opens || !chatWorktreeId) {
    return (
      <span aria-hidden={!spoken || undefined} className={NATIVE_CHAT_READABLE_SHARE} title={title}>
        {label}
      </span>
    )
  }
  return (
    <button
      type="button"
      aria-label={t('components.native-chat.agentMessage.open', 'Open {{name}}', {
        name: name ?? unnamedSenderLabel(t)
      })}
      title={title}
      className={`${NATIVE_CHAT_READABLE_SHARE} rounded-sm underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
      onClick={() =>
        void openAgentMessageSender(from, sender, chatWorktreeId, target, dispatchId, name)
      }
    >
      {label}
    </button>
  )
}

/** A sender's name as the chip that opens it (or plain when nothing can), whole on hover. */
export function SenderChip({
  from,
  sender,
  chatWorktreeId,
  target,
  dispatchId
}: {
  from: AgentMessageSource
  sender: AgentMessageSender
  chatWorktreeId: string | null
  target?: RuntimeClientTarget
  dispatchId?: string
}): React.JSX.Element {
  const t = useTranslate()
  const name = useAgentMessageSenderName(sender, chatWorktreeId, target, dispatchId)
  const label = name ?? unnamedSenderLabel(t)
  const opens = useAgentMessageSenderOpens(sender, chatWorktreeId, target, dispatchId)
  if (!opens || !chatWorktreeId) {
    return (
      <SenderTooltip label={label}>
        <span className={NATIVE_CHAT_INLINE_NAME}>{label}</span>
      </SenderTooltip>
    )
  }
  return (
    <SenderTooltip label={label}>
      <button
        type="button"
        aria-label={t('components.native-chat.agentMessage.open', 'Open {{name}}', { name: label })}
        className={NATIVE_CHAT_INLINE_CHIP}
        onClick={() =>
          void openAgentMessageSender(from, sender, chatWorktreeId, target, dispatchId, name)
        }
      >
        <span className="min-w-0 truncate">{label}</span>
      </button>
    </SenderTooltip>
  )
}

/** The whole name on hover, as an item chip shows its title. */
function SenderTooltip({
  label,
  children
}: {
  label: string
  children: React.ReactElement
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
