// Bot items waiting on the owner, as cards in the dashboard's Needs You column; a click opens the item
// in its bot's panel, as the panel's own Items tab does.
import { useMemo, useSyncExternalStore } from 'react'
import { AgentQuestionIcon } from '@/components/agent/status/AgentQuestionIcon'
import { BotAvatar } from '@/components/bots/BotAvatar'
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
import { botItemQuestionLine } from '../../../../../shared/bots/bot-item-ask'
import { botItemStaleDays, groupBotItems } from '../../../../../shared/bots/bot-item-groups'
import {
  botItemActivityAt,
  formatBotItemNumber,
  type BotItem
} from '../../../../../shared/bots/bot-items'

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

export function DashboardBotAsks({ onOpened }: { onOpened: () => void }): React.JSX.Element {
  const bots = useBots(useBotsEnabled())
  return (
    <>
      {bots.map((bot) => (
        <DashboardBotAsksOfBot key={botRefKey(bot)} bot={bot} onOpened={onOpened} />
      ))}
    </>
  )
}

/** Reads a bot's items only while its host counts some needing the owner. */
function DashboardBotAsksOfBot({
  bot,
  onOpened
}: {
  bot: Bot
  onOpened: () => void
}): React.JSX.Element | null {
  const count = useListedBotItemsNeedingOwner(bot) ?? 0
  return count > 0 ? <DashboardBotAskCards bot={bot} onOpened={onOpened} /> : null
}

function DashboardBotAskCards({
  bot,
  onOpened
}: {
  bot: Bot
  onOpened: () => void
}): React.JSX.Element {
  const { read } = useBotItems(bot)
  const now = useNow(60_000)
  const asks = useMemo(
    () =>
      read
        ? groupBotItems(read.items, botItemStaleDays(bot.itemsStale), now, read.seenEventId)
            .needs_you
        : [],
    [read, bot.itemsStale, now]
  )
  const open = (item: BotItem): void => {
    if (openBotHome(bot)) {
      openBotItem(bot, item.uid)
      onOpened()
    }
  }
  return (
    <>
      {asks.map((item) => (
        <DashboardBotAskCard
          key={item.uid}
          bot={bot}
          item={item}
          now={now}
          onOpen={() => open(item)}
        />
      ))}
    </>
  )
}

export function DashboardBotAskCard({
  bot,
  item,
  now,
  onOpen
}: {
  bot: Bot
  item: BotItem
  now: number
  onOpen: () => void
}): React.JSX.Element {
  const question = item.question
    ? (item.question.gist ?? botItemQuestionLine(item.question.text))
    : ''
  return (
    <button
      type="button"
      data-dashboard-bot-item={item.uid}
      onClick={onOpen}
      className="mt-2 flex w-full flex-col gap-1.5 rounded-lg border border-agent-question/40 bg-agent-question/[0.06] p-2.5 text-left transition-colors hover:border-agent-question/60 hover:bg-agent-question/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <span className="flex w-full min-w-0 items-center gap-1.5">
        <BotAvatar bot={bot} className="size-3.5 shrink-0 rounded-full text-[8px]" />
        <span className="truncate text-[12.5px] font-semibold text-foreground">{item.title}</span>
      </span>
      {question ? (
        <span className="flex w-full items-start gap-1 rounded-md bg-agent-question/15 px-1.5 py-1 text-[11px] text-agent-question-text ring-1 ring-inset ring-agent-question/25">
          <AgentQuestionIcon className="mt-px size-3 shrink-0" />
          <span className="line-clamp-2">{question}</span>
        </span>
      ) : null}
      <span className="flex w-full min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
        <span className="truncate">{bot.name}</span>
        <span className="shrink-0 tabular-nums">{formatBotItemNumber(item.number)}</span>
        <span className="ml-auto shrink-0 pl-1 tabular-nums">
          {formatShortTimeAgo(botItemActivityAt(item, now), now)}
        </span>
      </span>
    </button>
  )
}
