// The pill that floats at the list's foot while rows are checked: "N selected · Move to · ×". A move
// is one write: one mail, one turn for the bot. Move to also snoozes the open ones, which mails nobody.
import { ChevronUp, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import {
  botItemPickerStatuses,
  isOpenBotItemStatus,
  type BotItem,
  type BotItemStatus
} from '../../../../../shared/bots/bot-items'
import { BotItemSnoozeMenuItems, type BotItemSnoozing } from './BotItemSnooze'
import { BotItemStatusIcon } from './BotItemStatusIcon'
import { botItemPickName } from './bot-item-status-name'
import type { BotRef } from '@/lib/bot-hosts'
import { botHostTakes } from '../bot-host-capability'
import { BOTS_ITEM_WAITING_CAPABILITY } from '../../../../../shared/bot-runtime-capabilities'

export function BotItemSelectionPill({
  items,
  snoozing,
  botOf,
  onMove,
  onClear
}: {
  items: readonly BotItem[]
  snoozing: BotItemSnoozing
  /** Each item's bot, whose host says whether it has Waiting. */
  botOf: (item: BotItem) => BotRef
  /** Waiting asks what it waits on first; every other move is at once. */
  onMove: (to: BotItemStatus) => void
  onClear: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const count = items.length
  const open = items.filter((item) => isOpenBotItemStatus(item.status))
  const waiting = items.every((item) => botHostTakes(botOf(item), BOTS_ITEM_WAITING_CAPABILITY))
  return (
    <div className="sticky bottom-2 z-10 mx-auto flex items-center gap-0.5 rounded-full border border-border bg-popover py-0.5 pl-3 pr-1 text-xs shadow-lg">
      <span className="whitespace-nowrap font-medium tabular-nums">
        {t('bots.items.selected', '{{count}} selected', { count })}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="xs">
            {t('bots.items.pill.moveTo', 'Move to')}
            <ChevronUp className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" side="top">
          <DropdownMenuLabel>
            {t('bots.items.pill.moveCount', 'Move {{count}} items to', {
              count,
              defaultValue_one: 'Move {{count}} item to'
            })}
          </DropdownMenuLabel>
          {botItemPickerStatuses(waiting).map((status) => (
            <DropdownMenuItem key={status} onSelect={() => onMove(status)}>
              <span className="flex w-4 justify-center">
                <BotItemStatusIcon status={status} />
              </span>
              {botItemPickName(status, t)}
            </DropdownMenuItem>
          ))}
          {open.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <BotItemSnoozeMenuItems items={open} snoozing={snoozing} />
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t('bots.items.pill.clear', 'Clear selection')}
        onClick={onClear}
      >
        <X />
      </Button>
    </div>
  )
}
