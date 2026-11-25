import React, { useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { botRefKey } from '@/lib/bot-hosts'
import { useBotHostOffline } from '@/lib/bot-host-views'
import { useNow } from '@/lib/window-activity/use-now'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../shared/bot-types'
import { ChatWorkersActivity } from './ChatWorkersActivity'
import { BotUpNextSection } from './BotUpNextSection'
import { NO_ACTIVITY, useBotActivityAuthorityRead } from './use-bot-activity'
import { useBotAutomationDelete } from './use-bot-automation-delete'
import { hiddenAutomationCardKeys, withoutHiddenAutomations } from './bot-automation-delete-hides'
import { useBotNeedsYouCount, useBotNow } from './use-bot-now'
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
import { useBotForWorkspace, useBotGroupForWorkspace } from './bot-workspace'
import { BotGroupItemsPanel } from './BotGroupItemsPanel'
import { setBotSettingsPlace, useBotSettingsPlace } from './settings-view/bot-settings-place'
import { BotSettingsView } from './settings-view/BotSettingsView'
import {
  BOT_ITEM_GROUP_IDS,
  BOT_ITEM_NO_FILTER,
  botItemsByDispatch,
  type BotItemFilter
} from '../../../../shared/bots/bot-item-groups'
import { BotItemsFilterButton, BotItemsFilterChips } from './items/BotItemsFilter'
import { BotItemsSection } from './items/BotItemsSection'
import { BotItemsReadFailed } from './items/BotItemsReadFailed'
import { BotItemPane } from './items/BotItemPane'
import { useBotItemOpenRequest } from './items/bot-item-open'
import { botItemWalkReturnRow } from '../../../../shared/bots/bot-item-walk'
import { useBotItems } from './items/use-bot-items'
import { useBotItemsSeenAtOpen } from './items/use-bot-items-seen-mark'
import { useBotItemWalk } from './items/use-bot-item-walk'
import { useBotItemBackFocus } from './items/use-bot-item-back-focus'
import { useBotItemsShownList } from './items/use-bot-items-shown-list'
import { useRightSidebarGutterResize } from '@/components/right-sidebar/layout/right-sidebar-gutter-resize'
import {
  useBotAutomationOpenCount,
  useBotAutomationPlace,
  returnToActivity
} from './bot-automation-place'
import { BotAutomationPanel } from './BotAutomationPanel'

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
  const automation = useBotAutomationPlace(bot)
  const openCount = useBotAutomationOpenCount()
  const panel = React.useRef<HTMLDivElement | null>(null)
  if (!settings && automation) {
    return (
      <div ref={panel} className="flex min-h-0 flex-1 flex-col">
        <BotAutomationPanel
          // Every open is a fresh screen, so opening the same automation again re-reads it.
          key={openCount}
          bot={bot}
          place={automation}
          onBack={() => returnToActivity(panel.current, automation, 'origin')}
        />
      </div>
    )
  }
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
  const activityRead = useBotActivityAuthorityRead(bot)
  // Its server is down: the panel shows the last read with its actions off until it's back.
  const offline = useBotHostOffline(bot.hostId)
  const deletion = useBotAutomationDelete(bot, activityRead, offline)
  const listedActivity = activityRead.read?.activity ?? NO_ACTIVITY
  // One projection for every place this tab names an automation: deleted here, it's gone from all.
  const activity = useMemo(
    () => withoutHiddenAutomations(listedActivity, deletion.hidden),
    [listedActivity, deletion.hidden]
  )
  const hiddenCardKeys = useMemo(
    () => hiddenAutomationCardKeys(listedActivity, deletion.hidden),
    [listedActivity, deletion.hidden]
  )
  const now = useBotNow(bot)
  const items = useBotItems(bot)
  const read = items.read
  const seenAtOpen = useBotItemsSeenAtOpen(bot, read, items.landed)
  const [filter, setFilterState] = useState<BotItemFilter>(BOT_ITEM_NO_FILTER)
  // The row Back returns focus to; another filter shows other rows.
  const [returnTo, setReturnTo] = useState<string | null>(null)
  const setFilter = (next: BotItemFilter): void => {
    setReturnTo(null)
    setFilterState(next)
  }
  const picture = useBotPictureSetting(bot, (updates) => updateBotReporting(bot, updates))
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
  const gutterResize = useRightSidebarGutterResize(scroll)
  useBotItemBackFocus(walk.uid !== null, scroll)
  const automationRows = useMemo(
    () => botAutomationCardRows(bot, activity, clock),
    [bot, activity, clock]
  )
  const stoppedForSignIn = useMemo(
    () =>
      now.stoppedForSignIn.flatMap((row) =>
        deletion.hidden.has(row.automation.id) ? [] : [{ ...row, hostId: bot.hostId }]
      ),
    [now.stoppedForSignIn, bot.hostId, deletion.hidden]
  )
  // Every ask leads Needs you, whatever the filter: Needs you only keeps them all.
  const asks = useMemo<BotNeedsYouAsks>(() => {
    const byDispatch = botItemsByDispatch(read?.items ?? [])
    return {
      needs: now.needs,
      stoppedForSignIn,
      itemOf: (dispatchId: string) => byDispatch.get(dispatchId) ?? null
    }
  }, [read, now.needs, stoppedForSignIn])
  // The badge's count, unfiltered: the header's dot and line say what the Items tab says.
  const needsYou = useBotNeedsYouCount(bot, now)
  const hasConnectorNeed = now.needs.some((need) => need.kind === 'connector')
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
      data-bot-items-scroller=""
      tabIndex={-1}
      // The bot row's hover card moves focus here when it opens the bot's Home.
      data-bot-home-panel=""
      data-bot-activity-scroller=""
      // The wider left padding is the sidebar's resize grab area, 4 px clear of every row.
      className="@container scrollbar-sleek flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto pl-3.5 pr-2 py-3 outline-none"
      {...gutterResize}
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
            <BotItemsFilterButton items={read.items} filter={filter} onFilter={setFilter} />
          ) : null
        }
      />
      <fieldset disabled={offline} className="contents">
        {read ? <BotItemsFilterChips filter={filter} onFilter={setFilter} /> : null}
        {read && items.refreshFailed ? <BotItemsReadFailed stale onRetry={items.retry} /> : null}
        {/* Asks lead Needs you in every item-read state: loading, failed or empty. */}
        <BotItemsSection
          bot={bot}
          list={list}
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
          scroller={scroll}
        />
        <BotUpcomingSection
          bot={bot}
          rows={automationRows}
          hiddenKeys={hiddenCardKeys}
          deletion={deletion}
          panelFallback={scroll}
          upNext={activity.upNext?.state}
          hasAutomations={activity.automations.length + activity.waits.length > 0}
          hasConnectorNeed={hasConnectorNeed}
          now={clock}
        />
        {activity.upNext ? (
          <BotUpNextSection key={bot.id} bot={bot} upNext={activity.upNext} />
        ) : null}
      </fieldset>
    </div>
  )
}
