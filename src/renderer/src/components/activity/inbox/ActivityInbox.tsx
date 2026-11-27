// Activity with the app rail on: one flat list of notifications, newest first, like Slack's Activity. Never a
// monitor of what is running.
import React, { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '@/store'
import { useAppStoreWithHostStatuses } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import { selectSidebarLineageParentIdentities } from '@/store/slices/worktrees/metadata/cross-store-lineage-parents'
import {
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'
import { useTranslate } from '@/i18n/use-translate'
import { readBots, subscribeToBotChanges } from '@/lib/bot-catalog-snapshot'
import { botRefKey } from '@/lib/bot-hosts'
import { getFocusedAgentPaneKeyForWorktree } from '@/components/sidebar/workspace-card/activity/focused-agent-row-highlight'
import { useAllAgentPaneThreads } from '../threads/use-agent-pane-threads'
import { useActivityThreadActionBindings } from '../thread-list/use-activity-thread-action-bindings'
import type { AgentPaneThread } from '../threads/activity-thread-types'
import type { Bot } from '../../../../../shared/bot-types'
import { activityInboxKind } from './activity-inbox'
import { botOfWorkspace, isBotWorkspaceId } from './activity-inbox-bot-workspace'
import { activityThreadStatusId } from '../threads/activity-thread-presentation'
import { withOpenedEntry } from './activity-inbox-opened'
import {
  ActivityInboxBotItemsReader,
  useActivityInboxBotSources,
  type BotItemsNeedingYou
} from './ActivityInboxBotRows'
import { ActivityInboxEntryRow, type ActivityInboxEntry } from './activity-inbox-entries'
import { ActivityInboxEmpty } from './ActivityInboxEmpty'
import { ActivityInboxMarkAllRead } from './ActivityInboxMarkAllRead'

type AgentEntry = Extract<ActivityInboxEntry, { kind: 'agent' }>

function agentEntriesOf(
  threads: readonly AgentPaneThread[],
  bots: readonly Bot[]
): { entries: AgentEntry[]; hiddenUnread: AgentPaneThread[] } {
  const state = useAppStore.getState()
  const entries: AgentEntry[] = []
  // A bot's unread finished turns: not listed, but Mark all read still clears them, as it did when they were.
  const hiddenUnread: AgentPaneThread[] = []
  for (const thread of threads) {
    const kind = activityInboxKind(thread)
    if (kind === null || (kind === 'outcome' && !thread.unread)) {
      continue
    }
    // A bot's finished turns are its own work, not news to you; what it needs from you, and a failure only you
    // can fix, are. The same id-based check as the rail dot's, so the two never disagree.
    const hidden =
      kind === 'outcome' &&
      activityThreadStatusId(thread) !== 'failed' &&
      isBotWorkspaceId(state, bots, thread.worktree.id)
    if (hidden) {
      hiddenUnread.push(thread)
      continue
    }
    entries.push({
      kind: 'agent',
      key: `agent:${thread.paneKey}`,
      at: thread.latestTimestamp,
      thread,
      ask: kind === 'ask',
      bot: botOfWorkspace(state, bots, thread.worktree)
    })
  }
  return { entries, hiddenUnread }
}

/**
 * Agents waiting on you, bots' items in Needs you, access requests, and finished turns you haven't read, in one
 * list, newest first. A bot's own chats and workspaces show as that bot; dispatched child workers never show.
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
  // The row you last opened from this list; kept listed and highlighted until you open another or leave.
  const [opened, setOpened] = useState<ActivityInboxEntry | null>(null)
  const focusedPaneKey = useAppStore((s) =>
    s.activeView === 'terminal' && s.activeWorktreeId
      ? getFocusedAgentPaneKeyForWorktree(s, s.activeWorktreeId)
      : null
  )
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

  // Which bot a workspace belongs to reads its nesting and its host's status: recompute when either changes.
  const lineage = useAppStoreWithHostStatuses((s, statuses) =>
    selectSidebarLineageParentIdentities(s, statuses)
  )
  const folders = useAppStore(selectFolderWorkspaces)
  const worktreeRows = useAppStore(selectWorktreesByRepo)
  const detectedRows = useAppStore(selectDetectedWorktreesByRepo)
  const { entries: agentEntries, hiddenUnread } = useMemo(
    () => agentEntriesOf(allThreads, bots),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- lineage, folders and the worktree rows are what the bot check reads from the store.
    [allThreads, bots, lineage, folders, worktreeRows, detectedRows]
  )
  // Item rows only for bots the dot counts (live, unpaused, with items needing you); a chat-only bot's items are
  // read to open its chat's item, not listed.
  const countedBotKeys = useMemo(
    () => new Set(sources.bots.map(({ bot }) => botRefKey(bot))),
    [sources.bots]
  )
  const entries = useMemo(() => {
    const all: ActivityInboxEntry[] = [...agentEntries]
    for (const [key, { bot, items }] of itemsByBot) {
      if (!countedBotKeys.has(key)) {
        continue
      }
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
    return withOpenedEntry(all, opened, allThreads).sort((a, b) => b.at - a.at)
  }, [agentEntries, itemsByBot, countedBotKeys, sources.requests, bots, opened, allThreads])

  const agentThreads = useMemo(() => agentEntries.map((entry) => entry.thread), [agentEntries])
  const markAllReadThreads = useMemo(
    () => [...agentThreads, ...hiddenUnread],
    [agentThreads, hiddenUnread]
  )
  const { selectThread, markAllThreadsRead, hasUnreadThreads } = useActivityThreadActionBindings({
    visibleThreads: agentThreads,
    markAllReadThreads,
    acknowledgeAgents: storeData.acknowledgeAgents,
    unacknowledgeAgents: storeData.unacknowledgeAgents
  })

  // A bot item or access request you opened stays selected until you open another row, wherever focus goes
  // next (opening one focuses the bot's chat). Otherwise an agent row follows the pane you have focused; until
  // a focus lands, the agent row you opened keeps the highlight.
  const focusedKey = focusedPaneKey === null ? null : `agent:${focusedPaneKey}`
  const selectedKey =
    opened && opened.kind !== 'agent' ? opened.key : (focusedKey ?? opened?.key ?? null)

  // Items are read for bots with items needing you, and for bots whose chats are listed, so opening a chat's
  // notification can open the item it is about.
  const readBotsOf = useMemo(() => {
    const byKey = new Map<string, Bot>()
    for (const { bot } of sources.bots) {
      byKey.set(botRefKey(bot), bot)
    }
    for (const entry of agentEntries) {
      if (entry.bot && !byKey.has(botRefKey(entry.bot))) {
        byKey.set(botRefKey(entry.bot), entry.bot)
      }
    }
    return [...byKey.values()]
  }, [sources.bots, agentEntries])

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
      {readBotsOf.map((bot) => (
        <ActivityInboxBotItemsReader key={botRefKey(bot)} bot={bot} onItems={onItems} />
      ))}
      {entries.length > 0 ? (
        <ul aria-label={t('appRail.activity', 'Activity')}>
          {entries.map((entry) => (
            <ActivityInboxEntryRow
              key={entry.key}
              entry={entry}
              selected={entry.key === selectedKey}
              onOpened={setOpened}
              onOpenThread={selectThread}
            />
          ))}
        </ul>
      ) : itemsPending ? null : (
        <ActivityInboxEmpty />
      )}
    </div>
  )
}
