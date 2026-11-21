// Bot items waiting on the owner, as cards in the dashboard's Needs You column; a click opens the item
// in its bot's panel, as the panel's own Items tab does.
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { AgentQuestionIcon } from '@/components/agent/status/AgentQuestionIcon'
import { BotAvatar, CarriedBotAvatar } from '@/components/bots/BotAvatar'
import { openBotItem } from '@/components/bots/items/bot-item-open'
import { useBotItems } from '@/components/bots/items/use-bot-items'
import {
  openBotHome,
  readBots,
  subscribeToBotChanges,
  useBots,
  useBotsEnabled,
  useListedBotItemsNeedingOwner
} from '@/lib/bot-catalog'
import { readBotItemsNeedingOwner } from '@/lib/bot-catalog-snapshot'
import { botRefKey } from '@/lib/bot-hosts'
import { formatShortTimeAgo } from '@/lib/time-format/short-time-ago'
import { useNow } from '@/lib/window-activity/use-now'
import type { Bot } from '../../../../../shared/bot-types'
import type {
  DashboardBotAsk,
  DashboardOpenBotItemArgs
} from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import { botItemQuestionLine } from '../../../../../shared/bots/bot-item-ask'
import { botItemStaleDays, groupBotItems } from '../../../../../shared/bots/bot-item-groups'
import {
  botItemActivityAt,
  formatBotItemNumber,
  type BotItem
} from '../../../../../shared/bots/bot-items'
import { clearDashboardBotAsks, setDashboardBotAsks } from './dashboard-bot-asks-feed'

const ASK_AVATAR_CLASS = 'size-3.5 shrink-0 rounded-full text-[8px]'

function readBotAskCount(): number {
  return readBots().reduce((sum, bot) => sum + (readBotItemsNeedingOwner(bot) ?? 0), 0)
}

/** Every bot's Needs you items, as their hosts count them: what the bots' own badges say. */
export function useDashboardBotAskCount(): number {
  const enabled = useBotsEnabled()
  // Keeps the bot list loaded and followed; the count reads the same list.
  useBots(enabled)
  const count = useSyncExternalStore(subscribeToBotChanges, readBotAskCount, readBotAskCount)
  return enabled ? count : 0
}

/** The card's fields, plain enough to cross to the pop-out in its snapshot. */
export function toDashboardBotAsk(bot: Bot, item: BotItem, now: number): DashboardBotAsk {
  const question = item.question
    ? (item.question.gist ?? botItemQuestionLine(item.question.text))
    : ''
  return {
    botHostId: bot.hostId,
    botId: bot.id,
    botName: bot.name,
    botAvatar: bot.avatar,
    itemUid: item.uid,
    title: item.title,
    question,
    number: item.number,
    activityAt: botItemActivityAt(item, now)
  }
}

/** The bot's Needs you items as its Items tab groups them, so stale and deferred ones stay out. */
function useBotAsks(bot: Bot, now: number): BotItem[] {
  const { read } = useBotItems(bot)
  return useMemo(
    () =>
      read
        ? groupBotItems(read.items, botItemStaleDays(bot.itemsStale), now, read.seenEventId)
            .needs_you
        : [],
    [read, bot.itemsStale, now]
  )
}

type RenderBot = (bot: Bot) => React.JSX.Element

/** Renders `render` for each bot whose host counts items needing the owner; only those are read. */
function ForBotsAsking({ render }: { render: RenderBot }): React.JSX.Element {
  const bots = useBots(useBotsEnabled())
  return (
    <>
      {bots.map((bot) => (
        <IfBotAsks key={botRefKey(bot)} bot={bot} render={render} />
      ))}
    </>
  )
}

function IfBotAsks({ bot, render }: { bot: Bot; render: RenderBot }): React.JSX.Element | null {
  const count = useListedBotItemsNeedingOwner(bot) ?? 0
  return count > 0 ? render(bot) : null
}

export function DashboardBotAsks({ onOpened }: { onOpened: () => void }): React.JSX.Element {
  return <ForBotsAsking render={(bot) => <DashboardBotAskCards bot={bot} onOpened={onOpened} />} />
}

/** Opens the item in its bot's panel; false when the bot's home can't open yet. */
function openDashboardBotAsk(bot: Bot, itemUid: string): boolean {
  if (!openBotHome(bot)) {
    return false
  }
  openBotItem(bot, itemUid)
  return true
}

/** A pop-out card's click, relayed to the main window: the bot as listed now, by host and id. */
export function openRelayedDashboardBotAsk(args: DashboardOpenBotItemArgs): boolean {
  const bot = readBots().find((b) => b.id === args.botId && b.hostId === args.botHostId)
  return bot ? openDashboardBotAsk(bot, args.itemUid) : false
}

function DashboardBotAskCards({
  bot,
  onOpened
}: {
  bot: Bot
  onOpened: () => void
}): React.JSX.Element {
  const now = useNow(60_000)
  const asks = useBotAsks(bot, now)
  return (
    <>
      {asks.map((item) => (
        <DashboardBotAskCard
          key={item.uid}
          ask={toDashboardBotAsk(bot, item, now)}
          avatar={<BotAvatar bot={bot} className={ASK_AVATAR_CLASS} />}
          now={now}
          onOpen={() => {
            if (openDashboardBotAsk(bot, item.uid)) {
              onOpened()
            }
          }}
        />
      ))}
    </>
  )
}

/** Main window, while the pop-out is open: every bot's Needs you items, for the pop-out's snapshot. */
export function DashboardBotAsksFeed(): React.JSX.Element {
  return <ForBotsAsking render={(bot) => <BotAsksFeedOfBot bot={bot} />} />
}

function BotAsksFeedOfBot({ bot }: { bot: Bot }): null {
  const now = useNow(60_000)
  const items = useBotAsks(bot, now)
  const key = botRefKey(bot)
  useEffect(() => {
    setDashboardBotAsks(
      key,
      items.map((item) => toDashboardBotAsk(bot, item, now))
    )
  }, [key, bot, items, now])
  useEffect(() => () => clearDashboardBotAsks(key), [key])
  return null
}

/** The pop-out's cards, from its snapshot; a click asks the main window to open the item. */
export function PopoutDashboardBotAsks({ asks }: { asks: DashboardBotAsk[] }): React.JSX.Element {
  const now = useNow(60_000)
  return (
    <>
      {asks.map((ask) => (
        <DashboardBotAskCard
          key={`${ask.botHostId}\u0000${ask.botId}\u0000${ask.itemUid}`}
          ask={ask}
          // An uploaded picture is read from the bot's host, which the pop-out can't reach.
          avatar={
            <CarriedBotAvatar
              name={ask.botName}
              avatar={ask.botAvatar}
              className={ASK_AVATAR_CLASS}
            />
          }
          now={now}
          onOpen={() => {
            void window.api.dashboard.openBotItem?.({
              botHostId: ask.botHostId,
              botId: ask.botId,
              itemUid: ask.itemUid
            })
          }}
        />
      ))}
    </>
  )
}

export function DashboardBotAskCard({
  ask,
  avatar,
  now,
  onOpen
}: {
  ask: DashboardBotAsk
  avatar: React.ReactNode
  now: number
  onOpen: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-dashboard-bot-item={ask.itemUid}
      onClick={onOpen}
      className="mt-2 flex w-full flex-col gap-1.5 rounded-lg border border-agent-question/40 bg-agent-question/[0.06] p-2.5 text-left transition-colors hover:border-agent-question/60 hover:bg-agent-question/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <span className="flex w-full min-w-0 items-center gap-1.5">
        {avatar}
        <span className="truncate text-[12.5px] font-semibold text-foreground">{ask.title}</span>
      </span>
      {ask.question ? (
        <span className="flex w-full items-start gap-1 rounded-md bg-agent-question/15 px-1.5 py-1 text-[11px] text-agent-question-text ring-1 ring-inset ring-agent-question/25">
          <AgentQuestionIcon className="mt-px size-3 shrink-0" />
          <span className="line-clamp-2">{ask.question}</span>
        </span>
      ) : null}
      <span className="flex w-full min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
        <span className="truncate">{ask.botName}</span>
        <span className="shrink-0 tabular-nums">{formatBotItemNumber(ask.number)}</span>
        <span className="ml-auto shrink-0 pl-1 tabular-nums">
          {formatShortTimeAgo(ask.activityAt, now)}
        </span>
      </span>
    </button>
  )
}
