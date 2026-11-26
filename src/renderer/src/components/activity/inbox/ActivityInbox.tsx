// Activity with the app rail on: one flat list of notifications, newest first, like Slack's Activity. Never a
// monitor of what is running.
import React, { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { readBots, subscribeToBotChanges } from '@/lib/bot-catalog-snapshot'
import { botRefKey } from '@/lib/bot-hosts'
import { readRuntimeStatuses } from '@/store/slices/runtime-status/views/runtime-status-owner'
import { findBotByWorkspace } from '@/components/bots/bot-workspace'
import { botOfFolders, selectFolderAncestors } from '@/components/bots/use-worktree-bot'
import { useAllAgentPaneThreads } from '../threads/use-agent-pane-threads'
import { useActivityThreadActionBindings } from '../thread-list/use-activity-thread-action-bindings'
import type { AgentPaneThread } from '../threads/activity-thread-types'
import type { Bot } from '../../../../../shared/bot-types'
import { activityInboxKind } from './activity-inbox'
import {
  ActivityInboxBotItemsReader,
  useActivityInboxBotSources,
  type BotItemsNeedingYou
} from './ActivityInboxBotRows'
import { ActivityInboxEntryRow, type ActivityInboxEntry } from './activity-inbox-entries'
import { ActivityInboxEmpty } from './ActivityInboxEmpty'
import { ActivityInboxMarkAllRead } from './ActivityInboxMarkAllRead'

type AgentEntry = Extract<ActivityInboxEntry, { kind: 'agent' }>

/** The bot whose workspace a thread runs in: its home folder, or a workspace nested under that home. */
function createBotOfThread(bots: readonly Bot[]): (thread: AgentPaneThread) => Bot | null {
  if (bots.length === 0) {
    return () => null
  }
  const state = useAppStore.getState()
  const statuses = readRuntimeStatuses()
  return (thread) =>
    findBotByWorkspace(bots, thread.worktree.id) ??
    botOfFolders(selectFolderAncestors(state, statuses, thread.worktree), bots)
}

function agentEntriesOf(
  threads: readonly AgentPaneThread[],
  bots: readonly Bot[],
  openedPaneKey: string | null
): AgentEntry[] {
  const botOfThread = createBotOfThread(bots)
  const entries: AgentEntry[] = []
  for (const thread of threads) {
    const kind = activityInboxKind(thread)
    const listed =
      kind === 'ask' || (kind === 'outcome' && (thread.unread || thread.paneKey === openedPaneKey))
    if (listed) {
      entries.push({
        kind: 'agent',
        key: `agent:${thread.paneKey}`,
        at: thread.latestTimestamp,
        thread,
        ask: kind === 'ask',
        bot: botOfThread(thread)
      })
    }
  }
  return entries
}

/**
 * Agents waiting on you, bots' items in Needs you, access requests, and finished turns you haven't read, in one
 * list, newest first. A bot's own chats and workspaces show as that bot; dispatched child workers never show.
 * Opening a finished row reads it; it stays until you leave Activity, so the row you clicked never vanishes.
 */
export default function ActivityInbox({
  actionsTarget
}: {
  actionsTarget?: HTMLElement | null
}): React.JSX.Element {
  const t = useTranslate()
  const { storeData, allThreads } = useAllAgentPaneThreads()
  const bots = useSyncExternalStore(subscribeToBotChanges, readBots)
  const sources = useActivityInboxBotSources()
  const [openedPaneKey, setOpenedPaneKey] = useState<string | null>(null)
  const [itemsByBot, setItemsByBot] = useState<ReadonlyMap<string, BotItemsNeedingYou>>(
    () => new Map()
  )
  const onItems = useCallback((key: string, value: BotItemsNeedingYou | undefined) => {
    setItemsByBot((previous) => {
      if (previous.get(key) === value) {
        return previous
      }
      const next = new Map(previous)
      if (value) {
        next.set(key, value)
      } else {
        next.delete(key)
      }
      return next
    })
  }, [])

  const agentEntries = useMemo(
    () => agentEntriesOf(allThreads, bots, openedPaneKey),
    [allThreads, bots, openedPaneKey]
  )
  const entries = useMemo(() => {
    const all: ActivityInboxEntry[] = [...agentEntries]
    for (const { bot, items } of itemsByBot.values()) {
      for (const item of items ?? []) {
        all.push({
          kind: 'item',
          key: `item:${botRefKey(bot)}:${item.uid}`,
          at: item.lastActivityAt,
          bot,
          item
        })
      }
    }
    for (const request of sources.requests) {
      all.push({
        kind: 'access',
        key: `access:${request.hostId}:${request.requestId}`,
        at: request.createdAt,
        request,
        bot: bots.find((bot) => bot.id === request.botId && bot.hostId === request.hostId) ?? null
      })
    }
    return all.sort((a, b) => b.at - a.at)
  }, [agentEntries, itemsByBot, sources.requests, bots])

  const agentThreads = useMemo(() => agentEntries.map((entry) => entry.thread), [agentEntries])
  const { selectThread, markAllThreadsRead, hasUnreadThreads } = useActivityThreadActionBindings({
    visibleThreads: agentThreads,
    markAllReadThreads: agentThreads,
    acknowledgeAgents: storeData.acknowledgeAgents,
    unacknowledgeAgents: storeData.unacknowledgeAgents,
    setSelectedPaneKey: setOpenedPaneKey
  })

  // A bot whose items are still being read may hold the only rows: say nothing rather than "all caught up".
  const itemsPending = sources.bots.some(({ bot }) => !itemsByBot.get(botRefKey(bot))?.items)
  const actions = actionsTarget
    ? createPortal(
        <ActivityInboxMarkAllRead
          disabled={!hasUnreadThreads}
          onMarkAllRead={markAllThreadsRead}
        />,
        actionsTarget
      )
    : null

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-1.5 pb-2 scrollbar-sleek">
      {actions}
      {sources.bots.map(({ bot }) => (
        <ActivityInboxBotItemsReader key={botRefKey(bot)} bot={bot} onItems={onItems} />
      ))}
      {entries.length > 0 ? (
        <ul aria-label={t('appRail.activity', 'Activity')}>
          {entries.map((entry) => (
            <ActivityInboxEntryRow key={entry.key} entry={entry} onOpenThread={selectThread} />
          ))}
        </ul>
      ) : itemsPending ? null : (
        <ActivityInboxEmpty />
      )}
    </div>
  )
}
