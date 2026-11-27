// One notification in the flat inbox, and how each kind draws: an agent (or a bot's own chat), a bot's item in
// Needs you, or an access request. Every row has one shape: avatar, who, when, what, and where.
import React from 'react'
import { CircleHelp, UserPlus } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { reviewAccessRequest, type HostAccessRequest } from '@/lib/bot-access-requests'
import { AgentTypeIcon } from '@/components/agent/icons/agent-type-icon'
import { AgentStateDot } from '@/components/agent/status/AgentStateDot'
import { BotAvatar } from '@/components/bots/BotAvatar'
import { openBotHomePanelFromSidebar } from '@/components/bots/BotRow'
import { openBotItem } from '@/components/bots/items/bot-item-open'
import { botItemsLastRead } from '@/components/bots/items/use-bot-items'
import { botItemForChat } from './activity-inbox-chat-item'
import { findBotByWorkspace } from '@/components/bots/bot-workspace'
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
      gone?: true
    }
  | { kind: 'item'; key: string; at: number; bot: Bot; item: BotItem; gone?: true }
  | {
      kind: 'access'
      key: string
      at: number
      request: HostAccessRequest
      bot: Bot | null
      /** Kept only because you opened it: answered, or its pane closed. Opening it again does nothing. */
      gone?: true
    }

// Rows show one plain line; inline code and bold markers would otherwise print as literal characters.
const plainLine = (line: string): string => line.replace(/`|\*\*/g, '')

const botAvatar = (bot: Bot): React.JSX.Element => (
  <BotAvatar bot={bot} className="size-4 rounded-full" />
)

type RowProps<Kind extends ActivityInboxEntry['kind']> = {
  entry: Extract<ActivityInboxEntry, { kind: Kind }>
  selected: boolean
  /** Records the row you opened, before it opens: it stays listed and highlighted. */
  onOpened: (entry: ActivityInboxEntry) => void
}

export const ActivityInboxEntryRow = React.memo(function ActivityInboxEntryRow({
  entry,
  selected,
  onOpened,
  onOpenThread
}: {
  entry: ActivityInboxEntry
  selected: boolean
  onOpened: (entry: ActivityInboxEntry) => void
  onOpenThread: (thread: AgentPaneThread) => void
}): React.JSX.Element {
  switch (entry.kind) {
    case 'agent':
      return (
        <AgentEntryRow
          entry={entry}
          selected={selected}
          onOpened={onOpened}
          onOpenThread={onOpenThread}
        />
      )
    case 'item':
      return <ItemEntryRow entry={entry} selected={selected} onOpened={onOpened} />
    case 'access':
      return <AccessEntryRow entry={entry} selected={selected} onOpened={onOpened} />
  }
})

/** The bot's Home on the right, where its Needs you and items are; focus stays where the open put it. */
function showBotHomePanel(): void {
  const { setRightSidebarTab, setRightSidebarOpen } = useAppStore.getState()
  setRightSidebarTab('bot-activity')
  setRightSidebarOpen(true)
}

function AgentEntryRow({
  entry,
  selected,
  onOpened,
  onOpenThread
}: RowProps<'agent'> & { onOpenThread: (thread: AgentPaneThread) => void }): React.JSX.Element {
  const { thread, ask, bot } = entry
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
      selected={selected}
      onOpen={() => {
        onOpened(entry)
        // Its pane is closed: the row stays for you to see, but there is nothing to open.
        if (entry.gone) {
          return
        }
        onOpenThread(thread)
        // A chat in the bot's own home: the right side is that bot's page, so open the item this chat is
        // about, else its Home. A workspace nested under the home is no bot page, and an item request
        // nothing takes would fire later, when the bot next opens.
        if (bot && findBotByWorkspace([bot], thread.worktree.id) !== null) {
          const item = botItemForChat(thread, botItemsLastRead(bot))
          if (item) {
            openBotItem(bot, item.uid)
          } else {
            showBotHomePanel()
          }
        }
      }}
    />
  )
}

function ItemEntryRow({ entry, selected, onOpened }: RowProps<'item'>): React.JSX.Element {
  const { bot, item } = entry
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
      selected={selected}
      onOpen={() => {
        onOpened(entry)
        openBotHomePanelFromSidebar(bot, () => openBotItem(bot, item.uid))
      }}
    />
  )
}

function AccessEntryRow({ entry, selected, onOpened }: RowProps<'access'>): React.JSX.Element {
  const { request, bot } = entry
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
      selected={selected}
      onOpen={() => {
        onOpened(entry)
        // Answered since you opened it: reviewing it again would bring the closed request back.
        if (!entry.gone) {
          reviewAccessRequest(request)
        }
      }}
    />
  )
}
