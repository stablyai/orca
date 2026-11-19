import React, { useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { botRefKey } from '@/lib/bot-hosts'
import { useBotHostOffline } from '@/lib/bot-host-views'
import { useNow } from '@/lib/window-activity/use-now'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../shared/bot-types'
import { ChatWorkersActivity } from './ChatWorkersActivity'
import { BotUpNextSection } from './BotUpNextSection'
import { useBotActivity } from './use-bot-activity'
import { useBotNeedsYouCount, useBotNow } from './use-bot-now'
import { useBotChatTree } from './use-bot-chat-tree'
import { updateBotReporting } from './bot-update-reporting'
import { useBotPictureSetting } from '../settings/bots/use-bot-picture-setting'
import { BotPanelHeader } from './BotPanelHeader'
import {
  botAutomationCardRows,
  botNextRun,
  botRunningRow,
  type BotAutomationCardRow
} from './bot-automation-card'
import type { BotNeedsYouAsks } from './BotNeedsYouSection'
import { BotUpcomingSection } from './BotUpcomingSection'
import { BotRecentSection, BotWorkingSection } from './BotWorkingRecentSections'
import { useBotForWorkspace, useBotGroupForWorkspace } from './bot-workspace'
import { BotGroupItemsPanel } from './BotGroupItemsPanel'
import { setBotSettingsPlace, useBotSettingsPlace } from './settings-view/bot-settings-place'
import { BotSettingsView } from './settings-view/BotSettingsView'
import {
  BOT_ITEM_GROUP_IDS,
  BOT_ITEM_NO_FILTER,
  botItemChats,
  botItemFilterChat,
  botItemsByDispatch,
  botNeedChat,
  filterBotNeeds,
  type BotItemFilter
} from '../../../../shared/bots/bot-item-groups'
import { BotItemsFilterButton, BotItemsFilterChips } from './items/BotItemsFilter'
import { BotItemsSection } from './items/BotItemsSection'
import { BotItemsReadFailed } from './items/BotItemsReadFailed'
import { BotItemPane } from './items/BotItemPane'
import { useBotItemOpenRequest } from './items/bot-item-open'
import { botItemWalkReturnRow } from './items/bot-item-walk'
import { useBotItems, useBotItemsSeenAtOpen } from './items/use-bot-items'
import { useBotItemWalk } from './items/use-bot-item-walk'
import { useBotItemsShownList } from './items/use-bot-items-shown-list'

/** Focus after the panel shows Activity again: the gear that opened settings. */
function focusGearAfterClose(panel: HTMLElement | null): void {
  requestAnimationFrame(() => panel?.querySelector<HTMLElement>('[data-bot-panel-gear]')?.focus())
}

/** The right sidebar's Activity panel: a bot's header and Activity list or its settings, a group's
 *  members' items, or the focused chat's workers. */
export default function BotActivityPanel(): React.JSX.Element | null {
  const workspaceId = useAppStore((s) => s.activeWorktreeId)
  const bot = useBotForWorkspace(workspaceId)
  const group = useBotGroupForWorkspace(bot ? null : workspaceId)
  if (group) {
    return <BotGroupItemsPanel key={group.id} group={group} />
  }
  if (!bot) {
    return <ChatWorkersActivity />
  }
  return <BotActivityOrSettings key={bot.id} bot={bot} />
}

function BotActivityOrSettings({ bot }: { bot: Bot }): React.JSX.Element {
  const settings = useBotSettingsPlace('panel', bot.id)
  const panel = React.useRef<HTMLDivElement | null>(null)
  if (!settings) {
    return (
      <div ref={panel} className="flex min-h-0 flex-1 flex-col">
        <BotActivityTab bot={bot} />
      </div>
    )
  }
  const close = (): void => {
    const hadFocus = panel.current?.contains(document.activeElement) ?? false
    setBotSettingsPlace('panel', null)
    if (hadFocus) {
      focusGearAfterClose(panel.current)
    }
  }
  return (
    <div ref={panel} className="flex min-h-0 flex-1 flex-col">
      <BotSettingsView
        bot={bot}
        host="panel"
        onExit={close}
        onDeleted={() => setBotSettingsPlace('panel', null)}
      />
    </div>
  )
}

function BotActivityTab({ bot }: { bot: Bot }): React.JSX.Element {
  const t = useTranslate()
  const activity = useBotActivity(bot)
  const now = useBotNow(bot)
  const tree = useBotChatTree(bot)
  const chatsRead = tree.chats.length > 0
  const items = useBotItems(bot)
  const read = items.state === 'unsupported' ? null : items.read
  const seenAtOpen = useBotItemsSeenAtOpen(bot, read)
  const [filter, setFilterState] = useState<BotItemFilter>(BOT_ITEM_NO_FILTER)
  // The row Back returns focus to; another filter shows other rows.
  const [returnTo, setReturnTo] = useState<string | null>(null)
  const setFilter = (next: BotItemFilter): void => {
    setReturnTo(null)
    setFilterState(next)
  }
  const itemChats = useMemo(
    () => (read ? botItemChats(read.items, tree.chats) : []),
    [read, tree.chats]
  )
  const picture = useBotPictureSetting(bot, (updates) => updateBotReporting(bot, updates))
  // Its server is down: the panel shows the last read with its actions off until it's back.
  const offline = useBotHostOffline(bot.hostId)
  // "Today at…" and "next" roll over with the clock; a minute is fine-grained enough.
  const clock = useNow(60_000)
  // Read above the list/item switch: an open item walks this list, and Back finds its row in it.
  const list = useBotItemsShownList(bot, read, filter, clock, seenAtOpen ?? '')
  const walk = useBotItemWalk(list, botRefKey(bot))
  const openItem = (uid: string): void => {
    setReturnTo(null)
    walk.open(uid)
  }
  // A chat's item chip asks for an item: open it here when it is this bot's.
  useBotItemOpenRequest(bot, openItem)
  const back = (): void => {
    const left = walk.close()
    const listed = BOT_ITEM_GROUP_IDS.flatMap((id) => list.groups[id].map((item) => item.uid))
    setReturnTo(left ? botItemWalkReturnRow(left.walk, left.uid, listed) : null)
  }
  const scroll = React.useRef<HTMLDivElement | null>(null)
  const automationRows = useMemo(
    () => botAutomationCardRows(bot, activity, clock),
    [bot, activity, clock]
  )
  // Asks are filtered beside the items, by their chat; a sign-in or access request is no chat's.
  const asks = useMemo<BotNeedsYouAsks>(() => {
    const byDispatch = botItemsByDispatch(read?.items ?? [])
    const itemOf = (dispatchId: string) => byDispatch.get(dispatchId) ?? null
    const homeChatId = itemChats.find((chat) => chat.kind === 'home')?.chatId ?? bot.chatSessionId
    return {
      needs: filterBotNeeds(now.needs, filter, (need) => botNeedChat(need, homeChatId, itemOf)),
      stoppedForSignIn: filter.chatIds === null ? now.stoppedForSignIn : [],
      itemOf
    }
  }, [read, itemChats, bot.chatSessionId, now.needs, now.stoppedForSignIn, filter])
  // The badge's count, unfiltered: the header's dot and line say what the Items tab says.
  const needsYou = useBotNeedsYouCount(bot, now)
  const signInStops = useMemo(
    () => new Set(now.stoppedForSignIn.map((row) => row.key)),
    [now.stoppedForSignIn]
  )
  const rowName = (row: BotAutomationCardRow): string =>
    row.kind === 'look-around'
      ? t('settings.bots.lookAround.title', 'Look around')
      : row.kind === 'automation' || row.kind === 'wait'
        ? row.row.automation.name
        : t('bots.upcoming.tidyUp', 'Tidy memory')
  const runningRow = botRunningRow(automationRows)
  const nextRow = botNextRun(automationRows)
  const quiet = {
    running: runningRow ? rowName(runningRow) : null,
    next: nextRow ? { name: rowName(nextRow), at: nextRow.nextAt ?? 0 } : null
  }
  if (walk.uid) {
    const uid = walk.uid
    return (
      <BotItemPane
        bot={bot}
        uid={uid}
        listed={read?.items.find((item) => item.uid === uid)}
        walk={walk}
        offline={offline}
        onBack={back}
      />
    )
  }
  return (
    <div
      ref={scroll}
      tabIndex={-1}
      className="@container scrollbar-sleek flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-2 py-3 outline-none"
    >
      {/* Outside the fieldset, so its settings open offline too and say what's unavailable. */}
      <BotPanelHeader
        bot={bot}
        now={{ needsYou, working: now.working }}
        quiet={quiet}
        picture={picture}
        offline={offline}
        filter={
          read && read.items.length > 0 ? (
            <BotItemsFilterButton
              items={read.items}
              chats={itemChats}
              filter={filter}
              onFilter={setFilter}
            />
          ) : null
        }
      />
      <fieldset disabled={offline} className="contents">
        {read ? (
          <BotItemsFilterChips chats={itemChats} filter={filter} onFilter={setFilter} />
        ) : null}
        {read && items.refreshFailed ? <BotItemsReadFailed stale onRetry={items.retry} /> : null}
        {/* Asks lead Needs you in every item-read state: loading, failed, empty or unsupported. */}
        <BotItemsSection
          key={botItemFilterChat(filter) ?? ''}
          bot={bot}
          list={list}
          chats={itemChats}
          seenEventId={seenAtOpen}
          filter={filter}
          onFilter={setFilter}
          now={clock}
          focusUid={returnTo}
          onOpen={(item) => openItem(item.uid)}
          botRead={items}
          asks={asks}
          offline={offline}
          focusFallback={scroll}
        />
        {items.state === 'unsupported' ? (
          // A host without items keeps what's running here.
          <BotWorkingSection bot={bot} work={now.work} />
        ) : null}
        <BotUpcomingSection
          bot={bot}
          rows={automationRows}
          upNext={activity.upNext?.state}
          hasAutomations={activity.automations.length + activity.waits.length > 0}
          signInStops={signInStops}
          now={clock}
        />
        {activity.upNext ? (
          <BotUpNextSection key={bot.id} bot={bot} upNext={activity.upNext} />
        ) : null}
        {chatsRead || read ? null : <BotRecentSection bot={bot} completed={activity.completed} />}
      </fieldset>
    </div>
  )
}
