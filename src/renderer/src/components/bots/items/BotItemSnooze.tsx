// Snoozing items from a menu: a Snooze submenu with Later today, Tomorrow, Monday and Pick a time…,
// Unsnooze while snoozed, and the Pick a time dialog. The item keeps its status; the bot isn't mailed.
import { useState } from 'react'
import { AlarmClock, AlarmClockOff, CalendarDays } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import { useTranslate } from '@/i18n/use-translate'
import { useNow } from '@/lib/window-activity/use-now'
import type { BotRef } from '@/lib/bot-hosts'
import { isBotItemSnoozed, type BotItem } from '../../../../../shared/bots/bot-items'
import {
  BOT_ITEM_SNOOZE_MAX_MS,
  botItemSnoozePresetName,
  botItemSnoozePresets,
  botItemSnoozeTimeFormat
} from '../../../../../shared/bots/bot-item-snooze'
import { botErrorMessage } from '../bot-presentation'
import { botItemsByBot, snoozeBotItems } from './use-bot-items'

/** A wake time as rows and menus say it: "6:00 PM", "Thu 9:00 AM" or "Nov 30, 9:00 AM". */
export function formatBotItemSnoozeTime(until: number, now: number): string {
  return uiDateTimeFormat(botItemSnoozeTimeFormat(until, now)).format(until)
}

export type BotItemSnoozing = {
  snooze: (items: readonly BotItem[], until: number | null) => void
  /** Opens Pick a time for these items. */
  pick: (items: readonly BotItem[]) => void
  /** The Pick a time dialog, mounted once beside the menus that open it. */
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

const two = (value: number): string => String(value).padStart(2, '0')

/** `yyyy-mm-dd` and `hh:mm` in local time, as date and time inputs take them. */
function inputValues(at: number): { date: string; time: string } {
  const day = new Date(at)
  return {
    date: `${day.getFullYear()}-${two(day.getMonth() + 1)}-${two(day.getDate())}`,
    time: `${two(day.getHours())}:${two(day.getMinutes())}`
  }
}

function BotItemSnoozeDialog({
  open,
  onSnooze,
  onClose
}: {
  open: boolean
  onSnooze: (until: number) => void
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const now = useNow(30_000)
  const tomorrow = () =>
    inputValues(botItemSnoozePresets(now).find((preset) => preset.id === 'tomorrow')?.at ?? now)
  const [opened, setOpened] = useState(open)
  const [value, setValue] = useState(tomorrow)
  // Each opening starts from tomorrow at 9 AM.
  if (open !== opened) {
    setOpened(open)
    if (open) {
      setValue(tomorrow())
    }
  }
  const until = new Date(`${value.date}T${value.time}`).getTime()
  const valid = Number.isFinite(until) && until > now && until <= now + BOT_ITEM_SNOOZE_MAX_MS
  const submit = (): void => {
    if (valid) {
      onSnooze(until)
    }
  }
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('bots.items.snooze.pickTitle', 'Snooze until')}</DialogTitle>
          <DialogDescription>
            {t(
              'bots.items.snooze.pickWhy',
              'It leaves its group until then and keeps its status. A new question or a close from the bot brings it back sooner.'
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <Input
            type="date"
            aria-label={t('bots.items.snooze.date', 'Date')}
            value={value.date}
            min={inputValues(now).date}
            onChange={(event) => setValue({ ...value, date: event.target.value })}
          />
          <Input
            type="time"
            aria-label={t('bots.items.snooze.time', 'Time')}
            value={value.time}
            onChange={(event) => setValue({ ...value, time: event.target.value })}
          />
        </form>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('bots.items.snooze.back', 'Back')}
          </Button>
          <Button size="sm" disabled={!valid} onClick={submit}>
            {valid
              ? t('bots.items.snooze.confirm', 'Snooze until {{when}}', {
                  when: formatBotItemSnoozeTime(until, now)
                })
              : t('bots.items.snooze.menu', 'Snooze')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
