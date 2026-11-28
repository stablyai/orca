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
import type { BotItem } from '../../../../../shared/bots/bot-items'
import { markBotItemsSeen } from '@/lib/bot-items-seen'
import { parseBotItemEventId } from '../../../../../shared/bots/bot-items'
import { activityInboxKind, isActivityInboxToDo } from './activity-inbox'
import { botOfWorkspace, isBotWorkspaceId } from './activity-inbox-bot-workspace'
import { activityThreadStatusId } from '../threads/activity-thread-presentation'
import { withOpenedEntry } from './activity-inbox-opened'
import {
  ActivityInboxBotItemsReader,
  isNewToYou,
  useActivityInboxBotSources,
  type BotItemsNeedingYou
} from './ActivityInboxBotRows'
import { ActivityInboxEntryRow, type ActivityInboxEntry } from './activity-inbox-entries'
import { ActivityInboxEmpty } from './ActivityInboxEmpty'
import { ActivityInboxMarkAllRead } from './ActivityInboxMarkAllRead'

type AgentEntry = Extract<ActivityInboxEntry, { kind: 'agent' }>

const itemEntryKey = (bot: Bot, item: BotItem): string => `item:${botRefKey(bot)}:${item.uid}`

type ItemEntry = Extract<ActivityInboxEntry, { kind: 'item' }>

const othersLastOf = (item: BotItem): number => parseBotItemEventId(item.othersLastEventId) ?? 0

/** Items you opened or cleared on this visit, at the event you saw: each stays gone until someone moves it again. */
function withDismissed(
  previous: ReadonlyMap<string, number>,
  entries: readonly ItemEntry[]
): ReadonlyMap<string, number> {
  const next = new Map(previous)
  for (const entry of entries) {
    next.set(entry.key, othersLastOf(entry.item))
  }
  return next
}

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
    // Read rows leave; an agent blocked on you is a to-do and stays until it is answered.
    const todo = kind !== null && isActivityInboxToDo(thread)
    if (kind === null || (!thread.unread && !todo)) {
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
      ...(todo ? { todo: true as const } : {}),
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
  // Bot items you opened or cleared here. A bot keeps one seen mark for all its items, so the rows of a bot you
  // haven't opened stay for this visit; these leave now.
  const [dismissed, setDismissed] = useState<ReadonlyMap<string, number>>(() => new Map())
  // The row you last opened from this list; kept listed and highlighted until you open another or leave.
  const [opened, setOpened] = useState<ActivityInboxEntry | null>(null)
  const openedKey = opened?.key ?? null
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
    for (const [botKey, { bot, items, seen }] of itemsByBot) {
      if (!countedBotKeys.has(botKey)) {
        continue
      }
      // An older host keeps no mark the inbox can read: its items are to-dos, listed until answered.
      const todo = seen === null
      for (const item of items ?? []) {
        const key = itemEntryKey(bot, item)
        // Seen items leave, except the one you have open: it stays until you leave Activity.
        const cleared = !todo && (dismissed.get(key) ?? -1) >= othersLastOf(item)
        if ((!isNewToYou(item, seen) || cleared) && openedKey !== key) {
          continue
        }
        all.push({
          kind: 'item',
          key,
          at: item.lastActivityAt,
          bot,
          item,
          ...(todo ? { todo: true as const } : {})
        })
      }
    }
    // A request is a to-do: listed until it is decided or expires, opened or not.
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
  }, [
    agentEntries,
    itemsByBot,
    countedBotKeys,
    dismissed,
    sources.requests,
    bots,
    opened,
    openedKey,
    allThreads
  ])

  const agentThreads = useMemo(() => agentEntries.map((entry) => entry.thread), [agentEntries])
  // To-dos are left alone: an agent blocked on you stays unread until you open it or answer it.
  const markAllReadThreads = useMemo(
    () => [
      ...agentEntries.filter((entry) => !entry.todo).map((entry) => entry.thread),
      ...hiddenUnread
    ],
    [agentEntries, hiddenUnread]
  )
  const { selectThread, markThreadRead, markAllThreadsRead, hasUnreadThreads } =
    useActivityThreadActionBindings({
      visibleThreads: agentThreads,
      markAllReadThreads,
      acknowledgeAgents: storeData.acknowledgeAgents,
      unacknowledgeAgents: storeData.unacknowledgeAgents
    })

  // Opening a row is seeing it: it is marked read (an agent's through its acknowledgement, even when its pane was
  // already focused or its tab is closed; a bot item's through its bot's seen mark, which the host keeps for every
  // device) and leaves once you open another or leave Activity. Until then it stays, highlighted. An access
  // request is a to-do: opening it marks nothing; deciding it takes it away.
  const openEntry = useCallback(
    (entry: ActivityInboxEntry) => {
      setOpened(entry)
      if (entry.kind === 'agent') {
        markThreadRead(entry.thread)
      } else if (entry.kind === 'item' && !entry.gone && !entry.todo) {
        setDismissed((previous) => withDismissed(previous, [entry]))
        void markBotItemsSeen(entry.bot)
      }
    },
    [markThreadRead]
  )
  // Bot items still new to you here: the one you have open is already read.
  const unreadItemRows = useMemo(
    () =>
      entries.filter(
        (entry): entry is ItemEntry =>
          entry.kind === 'item' && !entry.gone && !entry.todo && entry.key !== openedKey
      ),
    [entries, openedKey]
  )
  const markAllRead = useCallback(() => {
    markAllThreadsRead()
    if (unreadItemRows.length === 0) {
      return
    }
    setDismissed((previous) => withDismissed(previous, unreadItemRows))
    const botsToMark = new Map(unreadItemRows.map((entry) => [botRefKey(entry.bot), entry.bot]))
    for (const bot of botsToMark.values()) {
      void markBotItemsSeen(bot)
    }
  }, [markAllThreadsRead, unreadItemRows])
  // To-dos (access requests, an older host's items) are left alone by Mark all read, so they never keep it enabled.
  const hasUnread = hasUnreadThreads || unreadItemRows.length > 0

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
        <ActivityInboxMarkAllRead disabled={!hasUnread} onMarkAllRead={markAllRead} />,
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
              onOpened={openEntry}
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
