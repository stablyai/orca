// The Items tab's list part: the bot's items grouped, Orca's own asks leading Needs you whatever the item
// read says, then what it says of items: loading, failed, a new bot, all clear, or nothing matching.
import { ListChecks } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotItem } from '../../../../../shared/bots/bot-items'
import {
  BOT_ITEM_NO_FILTER,
  botItemFilterChat,
  isBotItemFilterOn,
  type BotItemChatChoice,
  type BotItemFilter,
  type BotItemGroups
} from '../../../../../shared/bots/bot-item-groups'
import { BotItemsList } from './BotItemsList'
import { BotItemsReadFailed } from './BotItemsReadFailed'
import type { BotItemsShownList } from './use-bot-items-shown-list'
import type { BotNeedsYouAsks } from '../BotNeedsYouSection'
import type { BotHostReadState } from '../use-bot-host-read'

const NO_GROUPS: BotItemGroups = {
  needs_you: [],
  working: [],
  planned: [],
  snoozed: [],
  stale: [],
  closed: []
}

export function BotItemsSection({
  bot,
  list,
  chats,
  seenEventId,
  filter,
  onFilter,
  now,
  focusUid,
  onOpen,
  botRead,
  asks,
  offline,
  focusFallback
}: {
  bot: Bot
  list: BotItemsShownList
  chats: readonly BotItemChatChoice[]
  /** Null until the first read says where the seen mark was. */
  seenEventId: string | null
  filter: BotItemFilter
  onFilter: (filter: BotItemFilter) => void
  now: number
  /** The row Back returns to: shown, focused and scrolled to once. */
  focusUid: string | null
  onOpen: (item: BotItem) => void
  /** The bot's own item read: `unsupported` for a host without items, which says nothing of them. */
  botRead: { state: BotHostReadState; retry: () => void }
  /** Orca's asks the filter keeps; they lead Needs you whatever the item read says. */
  asks: BotNeedsYouAsks
  offline: boolean
  focusFallback: React.RefObject<HTMLElement | null>
}): React.JSX.Element {
  const t = useTranslate()
  const { chatRead, items, shown, staleDays } = list
  // Rows wait for the seen mark as the tab opened, so none flashes as changed.
  const read = seenEventId === null ? null : list.read
  const groups = read ? list.groups : NO_GROUPS
  const filtered = isBotItemFilterOn(filter)
  const asking = asks.needs.length + asks.stoppedForSignIn.length > 0
  // Every message here speaks for items only; the asks above it stand on their own.
  const itemsNote = (): React.ReactNode => {
    if (!read) {
      if (botRead.state === 'unsupported') {
        return null
      }
      const chatFailed = filter.chatIds !== null && chatRead.failed
      return botRead.state === 'failed' || chatFailed ? (
        <BotItemsReadFailed onRetry={chatFailed ? chatRead.retry : botRead.retry} />
      ) : (
        <BotItemsLoading />
      )
    }
    if (items.length === 0 && !filtered) {
      return asking ? (
        <p className="px-6 py-1.5 text-center text-xs text-muted-foreground">
          {t(
            'bots.items.empty.short',
            'No items yet. When {{bot}} takes something on, it shows up here.',
            { bot: bot.name }
          )}
        </p>
      ) : (
        <div className="flex flex-col items-center gap-2 px-6 py-12 text-center text-xs text-muted-foreground">
          <ListChecks className="size-5" />
          <b className="text-[13px] font-medium text-foreground">
            {t('bots.items.empty.title', 'No items yet')}
          </b>
          {t(
            'bots.items.empty.body',
            'When {{bot}} takes on something for you, it shows up here with what it is doing and what it needs from you.',
            { bot: bot.name }
          )}
        </div>
      )
    }
    if (asking) {
      return null
    }
    if (filtered) {
      return shown.length === 0 ? (
        <FilteredEmpty chats={chats} filter={filter} onFilter={onFilter} />
      ) : null
    }
    return groups.needs_you.length === 0 && groups.working.length === 0 ? (
      <p className="px-6 py-6 text-center text-xs text-muted-foreground">
        {t('bots.items.empty.allClear', 'Nothing needs you and nothing is running.')}
      </p>
    ) : null
  }
  return (
    <>
      {/* A chat's re-read failed: its last read stays up, saying so, with Retry. */}
      {read && filter.chatIds !== null && chatRead.failed ? (
        <BotItemsReadFailed stale onRetry={chatRead.retry} />
      ) : null}
      {/* Mounted in every read state, so an ask keeps its place and focus as items arrive. */}
      <BotItemsList
        bot={bot}
        groups={groups}
        seenEventId={seenEventId ?? ''}
        closedTotal={list.closedTotal}
        onMoreClosed={list.loadMoreClosed}
        staleDays={staleDays}
        now={now}
        focusUid={focusUid}
        onOpen={onOpen}
        asks={asks}
        offline={offline}
        focusFallback={focusFallback}
      />
      {itemsNote()}
    </>
  )
}

function FilteredEmpty({
  chats,
  filter,
  onFilter
}: {
  chats: readonly BotItemChatChoice[]
  filter: BotItemFilter
  onFilter: (filter: BotItemFilter) => void
}): React.JSX.Element {
  const t = useTranslate()
  const chatId = botItemFilterChat(filter)
  const chat = chats.find((entry) => entry.chatId === chatId)
  const chatName =
    chat?.kind === 'home' ? t('bots.items.homeChat', 'Home Chat') : (chat?.title ?? '')
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-xs text-muted-foreground">
      {filter.needsYou
        ? chat
          ? t('bots.items.empty.chatNeedsYou', 'Nothing in {{chat}} needs you.', {
              chat: chatName
            })
          : t('bots.items.empty.needsYou', 'Nothing needs you.')
        : t('bots.items.empty.filtered', 'No items match.')}
      <Button variant="outline" size="xs" onClick={() => onFilter(BOT_ITEM_NO_FILTER)}>
        {t('bots.items.filter.clearAll', 'Clear filters')}
      </Button>
    </div>
  )
}

export function BotItemsLoading(): React.JSX.Element {
  const t = useTranslate()
  return (
    <p className="px-6 py-6 text-center text-xs text-muted-foreground">
      {t('bots.items.loading', 'Loading items…')}
    </p>
  )
}
