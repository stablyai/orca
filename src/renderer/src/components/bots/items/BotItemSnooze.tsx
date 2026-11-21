// Snoozing items from a menu: a Snooze submenu with Later today, Tomorrow, Monday and Pick a time…,
// Unsnooze while snoozed, and the Snooze until dialog. The item keeps its status; the bot isn't mailed.
import { useState } from 'react'
import { AlarmClock, AlarmClockOff, CalendarDays } from 'lucide-react'
import { toast } from 'sonner'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import type { BotRef } from '@/lib/bot-hosts'
import { isBotItemSnoozed, type BotItem } from '../../../../../shared/bots/bot-items'
import {
  botItemSnoozePresetName,
  botItemSnoozePresets
} from '../../../../../shared/bots/bot-item-snooze'
import { botErrorMessage } from '../bot-presentation'
import { botItemsByBot, snoozeBotItems } from './use-bot-items'
import { formatBotItemSnoozeTime } from './bot-item-snooze-time'
import { BotItemSnoozeDialog } from './BotItemSnoozeDialog'

export type BotItemSnoozing = {
  snooze: (items: readonly BotItem[], until: number | null) => void
  /** Opens the Snooze until dialog for these items. */
  pick: (items: readonly BotItem[]) => void
  /** The Snooze until dialog, mounted once beside the menus that open it. */
  dialog: React.ReactNode
}

/** Snooze writes for one bot's items; `done` runs once the host took one (a list clears its checks). */
/** `bot`: the items' bot, or each item's own in a group's merged list. */
export function useBotItemSnoozing(
  bot: BotRef | ((item: BotItem) => BotRef),
  done?: () => void
): BotItemSnoozing {
  const [picking, setPicking] = useState<readonly BotItem[] | null>(null)
  const snooze = (items: readonly BotItem[], until: number | null): void => {
    void Promise.all(
      botItemsByBot(items, bot).map(([ref, mine]) => snoozeBotItems(ref, mine, until))
    )
      .then(() => done?.())
      .catch((error: unknown) => toast.error(botErrorMessage(error)))
  }
  return {
    snooze,
    pick: setPicking,
    dialog: (
      <BotItemSnoozeDialog
        open={picking !== null}
        onSnooze={(until) => {
          if (picking) {
            snooze(picking, until)
          }
          setPicking(null)
        }}
        onClose={() => setPicking(null)}
      />
    )
  }
}

/** Snooze ▸ for an open item, or the open items of a selection; Unsnooze under it once one is snoozed. */
export function BotItemSnoozeMenuItems({
  items,
  snoozing
}: {
  items: readonly BotItem[]
  snoozing: BotItemSnoozing
}): React.JSX.Element {
  const t = useTranslate()
  // Read as the menu opens; the presets resolve against it.
  const [now] = useState(Date.now)
  const only = items.length === 1 ? items[0] : undefined
  const snoozedUntil = only && isBotItemSnoozed(only, now) ? only.snoozedUntil : null
  const anySnoozed = items.some((item) => isBotItemSnoozed(item, now))
  return (
    <>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <AlarmClock />
          {snoozedUntil !== null
            ? t('bots.items.snooze.until', 'Snoozed until {{when}}', {
                when: formatBotItemSnoozeTime(snoozedUntil, now)
              })
            : t('bots.items.snooze.menu', 'Snooze')}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {botItemSnoozePresets(now).map((preset) => (
            <DropdownMenuItem key={preset.id} onSelect={() => snoozing.snooze(items, preset.at)}>
              {botItemSnoozePresetName(preset, t)}
              <DropdownMenuShortcut>{formatBotItemSnoozeTime(preset.at, now)}</DropdownMenuShortcut>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => snoozing.pick(items)}>
            <CalendarDays />
            {t('bots.items.snooze.pick', 'Pick a time…')}
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      {anySnoozed ? (
        <DropdownMenuItem onSelect={() => snoozing.snooze(items, null)}>
          <AlarmClockOff />
          {t('bots.items.snooze.unsnooze', 'Unsnooze')}
        </DropdownMenuItem>
      ) : null}
    </>
  )
}
