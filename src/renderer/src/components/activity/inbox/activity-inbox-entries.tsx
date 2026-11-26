// One notification in the flat inbox, and how each kind draws: an agent (or a bot's own chat), a bot's item in
// Needs you, or an access request. Every row has one shape: avatar, who, when, what, and where.
import React from 'react'
import { CircleHelp, UserPlus } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { reviewAccessRequest, type HostAccessRequest } from '@/lib/bot-access-requests'
import { AgentTypeIcon } from '@/components/agent/icons/agent-type-icon'
import { AgentStateDot } from '@/components/agent/status/AgentStateDot'
import { BotAvatar } from '@/components/bots/BotAvatar'
import { openBotHomePanelFromSidebar } from '@/components/bots/BotRow'
import { openBotItem } from '@/components/bots/items/bot-item-open'
import type { Bot } from '../../../../../shared/bot-types'
import { formatBotItemNumber, type BotItem } from '../../../../../shared/bots/bot-items'
import {
  activityThreadRowCopy,
  activityThreadStatusId,
  threadAgentStateLabel
} from '../threads/activity-thread-presentation'
import type { AgentPaneThread } from '../threads/activity-thread-types'
import { ActivityInboxRow } from './ActivityInboxRow'

export type ActivityInboxEntry =
  | {
      kind: 'agent'
      key: string
      at: number
      thread: AgentPaneThread
      ask: boolean
      /** The bot whose workspace the agent runs in: its row is the bot's. */
      bot: Bot | null
    }
  | { kind: 'item'; key: string; at: number; bot: Bot; item: BotItem }
  | { kind: 'access'; key: string; at: number; request: HostAccessRequest; bot: Bot | null }

// Rows show one plain line; inline code and bold markers would otherwise print as literal characters.
const plainLine = (line: string): string => line.replace(/`|\*\*/g, '')

const botAvatar = (bot: Bot): React.JSX.Element => (
  <BotAvatar bot={bot} className="size-4 rounded-full" />
)

export const ActivityInboxEntryRow = React.memo(function ActivityInboxEntryRow({
  entry,
  onOpenThread
}: {
  entry: ActivityInboxEntry
  onOpenThread: (thread: AgentPaneThread) => void
}): React.JSX.Element {
  switch (entry.kind) {
    case 'agent':
      return <AgentEntryRow entry={entry} onOpenThread={onOpenThread} />
    case 'item':
      return <ItemEntryRow entry={entry} />
    case 'access':
      return <AccessEntryRow entry={entry} />
  }
})

function AgentEntryRow({
  entry: { thread, ask, bot },
  onOpenThread
}: {
  entry: Extract<ActivityInboxEntry, { kind: 'agent' }>
  onOpenThread: (thread: AgentPaneThread) => void
}): React.JSX.Element {
  const t = useTranslate()
  const { taskTitle, statusLine, workspaceLabel } = activityThreadRowCopy(thread, t)
  const where = bot ? taskTitle : workspaceLabel
  return (
    <ActivityInboxRow
      avatar={bot ? botAvatar(bot) : <AgentTypeIcon agentType={thread.agentType} size={14} />}
      title={bot ? bot.name : taskTitle}
      timestamp={thread.latestTimestamp}
      line={statusLine === null ? null : plainLine(statusLine)}
      ask={ask}
      contextIcon={<AgentStateDot state={activityThreadStatusId(thread)} size="sm" />}
      context={`${threadAgentStateLabel(thread, t)} · ${where}`}
      onOpen={() => onOpenThread(thread)}
    />
  )
}

function ItemEntryRow({
  entry: { bot, item }
}: {
  entry: Extract<ActivityInboxEntry, { kind: 'item' }>
}): React.JSX.Element {
  const t = useTranslate()
  const ask = item.question?.gist ?? item.waitingAsk
  return (
    <ActivityInboxRow
      avatar={botAvatar(bot)}
      title={bot.name}
      timestamp={item.lastActivityAt}
      line={item.title}
      ask
      contextIcon={<CircleHelp className="size-3" aria-hidden />}
      context={`${formatBotItemNumber(item.number)} · ${ask ? plainLine(ask) : t('activityInbox.itemNeedsYou', 'Needs you')}`}
      onOpen={() => openBotHomePanelFromSidebar(bot, () => openBotItem(bot, item.uid))}
    />
  )
}

function AccessEntryRow({
  entry: { request, bot }
}: {
  entry: Extract<ActivityInboxEntry, { kind: 'access' }>
}): React.JSX.Element {
  const t = useTranslate()
  // The name can be empty; the request toast falls back to the handle the same way.
  const requester = request.requester.name || request.requester.handle
  return (
    <ActivityInboxRow
      avatar={bot ? botAvatar(bot) : <UserPlus className="size-3.5 text-muted-foreground" />}
      title={bot?.name ?? requester}
      timestamp={request.createdAt}
      line={t('activityInbox.accessRequest', '{{name}} asked for access', { name: requester })}
      ask
      contextIcon={<UserPlus className="size-3" aria-hidden />}
      context={t('activityInbox.accessContext', 'Access request · {{source}}', {
        source: request.source === 'slack' ? 'Slack' : 'Linear'
      })}
      onOpen={() => reviewAccessRequest(request)}
    />
  )
}
