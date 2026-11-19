// The Items tab's list part: the bot's items grouped, Orca's own asks leading Needs you whatever the item
// read says, then what it says of items: all clear above them; loading, failed, a new bot or nothing matching below.
import { ListChecks } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotItem } from '../../../../../shared/bots/bot-items'
import {
  BOT_ITEM_NO_FILTER,
  isBotItemFilterOn,
  type BotItemFilter,
  type BotItemGroups
} from '../../../../../shared/bots/bot-item-groups'
import { cn } from '@/lib/class-names'
import { BotAvatar } from '../BotAvatar'
import { ALL_CLEAR_PICTURE, BotItemsAllClear } from './BotItemsAllClear'
import { BotItemsList } from './BotItemsList'
import { BotItemsLoading } from './BotItemsLoading'
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
  seenEventId,
  filter,
  onFilter,
  now,
  focusUid,
  onOpen,
  botRead,
  asks,
  offline,
  focusFallback,
  scroller
}: {
  bot: Bot
  list: BotItemsShownList
  /** Null until the first read says where the seen mark was. */
  seenEventId: string | null
  filter: BotItemFilter
  onFilter: (filter: BotItemFilter) => void
  now: number
  /** The row Back returns to: shown, focused and scrolled to once. */
  focusUid: string | null
  onOpen: (item: BotItem) => void
  /** The bot's own item read. */
  botRead: { state: BotHostReadState; retry: () => void }
  /** Orca's asks; they lead Needs you whatever the item read says. */
  asks: BotNeedsYouAsks
  offline: boolean
  focusFallback: React.RefObject<HTMLElement | null>
  /** The panel's scroller, for windowing long groups. */
  scroller?: React.RefObject<HTMLDivElement | null>
}): React.JSX.Element {
  const t = useTranslate()
  const { items, shown, staleDays } = list
  // Rows wait for the seen mark as the tab opened, so none flashes as changed.
  const read = seenEventId === null ? null : list.read
  const groups = read ? list.groups : NO_GROUPS
  const filtered = isBotItemFilterOn(filter)
  const asking = asks.needs.length + asks.stoppedForSignIn.length > 0
  // Every message here speaks for items only; the asks above it stand on their own.
  const itemsNote = (): React.ReactNode => {
    if (!read) {
      return botRead.state === 'failed' ? (
        <BotItemsReadFailed onRetry={botRead.retry} />
      ) : (
        // Needs you shows only for counted asks; runs a sign-in stopped, alone, leave it out.
        <BotItemsLoading afterAsks={asks.needs.length > 0} />
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
    return filtered && shown.length === 0 ? (
      <FilteredEmpty onClear={() => onFilter(BOT_ITEM_NO_FILTER)} />
    ) : null
  }
  // Paused and offline say so elsewhere; the line leads the folded sections rather than trailing them.
  const allClear =
    read !== null &&
    items.length > 0 &&
    !asking &&
    !filtered &&
    !bot.paused &&
    !offline &&
    groups.needs_you.length === 0 &&
    groups.working.length === 0
  return (
    <>
      {allClear ? (
        <BotItemsAllClear
          picture={
            <BotAvatar
              bot={bot}
              className={cn('size-10 rounded-[9px] text-base', ALL_CLEAR_PICTURE)}
            />
          }
        />
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
        scroller={scroller}
      />
      {itemsNote()}
    </>
  )
}

/** Needs you only, with nothing needing the owner. */
function FilteredEmpty({ onClear }: { onClear: () => void }): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-xs text-muted-foreground">
      {t('bots.items.empty.needsYou', 'Nothing needs you.')}
      <Button variant="outline" size="xs" onClick={onClear}>
        {t('bots.items.filter.clearAll', 'Clear filters')}
      </Button>
    </div>
  )
}
