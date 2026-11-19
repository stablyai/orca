// The Snooze until dialog: presets first, then a month grid and a quarter-hour time for a custom wake.
import { useId, useState } from 'react'
import { CalendarDays, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { MonthCalendar } from '@/components/ui/month-calendar'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import { useTranslate } from '@/i18n/use-translate'
import { useNow } from '@/lib/window-activity/use-now'
import {
  BOT_ITEM_SNOOZE_DEFAULT_MINUTES,
  botItemSnoozeAt,
  botItemSnoozeDayRange,
  botItemSnoozePickerPresets,
  botItemSnoozePresetName,
  botItemSnoozeSlotOn,
  botItemSnoozeSlots
} from '../../../../../shared/bots/bot-item-snooze'
import { formatBotItemSnoozeTime } from './bot-item-snooze-time'

const rowClass =
  'flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50'

function tomorrow(now: number): Date {
  const day = new Date(now)
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
}

export function BotItemSnoozeDialog({
  open,
  onSnooze,
  onClose
}: {
  open: boolean
  onSnooze: (until: number) => void
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const now = useNow(30_000, open)
  const timeLabel = useId()
  const summary = useId()
  const [opened, setOpened] = useState(open)
  const [picking, setPicking] = useState(false)
  const [day, setDay] = useState(() => tomorrow(now))
  const [minutes, setMinutes] = useState(BOT_ITEM_SNOOZE_DEFAULT_MINUTES)
  // Each opening starts on the presets, with the picker on tomorrow at 9 AM.
  if (open !== opened) {
    setOpened(open)
    if (open) {
      setPicking(false)
      setDay(tomorrow(now))
      setMinutes(BOT_ITEM_SNOOZE_DEFAULT_MINUTES)
    }
  }
  const range = botItemSnoozeDayRange(now)
  const pickedDay = day < range.first ? range.first : day > range.last ? range.last : day
  // A time that has passed on the chosen day rolls forward to the next open slot.
  const slot = botItemSnoozeSlotOn(pickedDay, minutes, now)
  const until = slot === null ? null : botItemSnoozeAt(pickedDay, slot)
  const slotLabel = uiDateTimeFormat({ hour: 'numeric', minute: '2-digit' })
  const submit = (): void => {
    if (until !== null) {
      onSnooze(until)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        size="confirm"
        showCloseButton
        className="sm:max-w-[340px]"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>{t('bots.items.snooze.pickTitle', 'Snooze until')}</DialogTitle>
        </DialogHeader>
        {picking ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              submit()
            }}
          >
            <MonthCalendar
              autoFocus
              selected={pickedDay}
              onSelect={setDay}
              today={new Date(now)}
              min={range.first}
              max={range.last}
            />
            <div className="flex h-8 items-center justify-between gap-2">
              <span id={timeLabel} className="text-sm">
                {t('bots.items.snooze.time', 'Time')}
              </span>
              <Select
                value={slot === null ? undefined : String(slot)}
                onValueChange={(value) => setMinutes(Number(value))}
              >
                <SelectTrigger size="sm" className="w-32" aria-labelledby={timeLabel}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" className="max-h-64">
                  {botItemSnoozeSlots(pickedDay, now).map((option) => (
                    <SelectItem key={option} value={String(option)}>
                      {slotLabel.format(botItemSnoozeAt(pickedDay, option))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter
              start={
                until === null ? null : (
                  <span id={summary} className="text-sm text-muted-foreground tabular-nums">
                    {formatBotItemSnoozeTime(until, now)}
                  </span>
                )
              }
            >
              <Button type="button" variant="outline" size="sm" onClick={() => setPicking(false)}>
                {t('bots.items.snooze.back', 'Back')}
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={until === null}
                aria-describedby={until === null ? undefined : summary}
              >
                {t('bots.items.snooze.menu', 'Snooze')}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="-mx-2 flex flex-col gap-0.5">
            {botItemSnoozePickerPresets(now).map((preset, index) => (
              <button
                key={preset.id}
                type="button"
                className={rowClass}
                autoFocus={index === 0}
                onClick={() => onSnooze(preset.at)}
              >
                <span className="flex-1">{botItemSnoozePresetName(preset, t)}</span>
                <span className="text-muted-foreground tabular-nums">
                  {formatBotItemSnoozeTime(preset.at, now)}
                </span>
              </button>
            ))}
            <Separator className="my-1" />
            <button type="button" className={rowClass} onClick={() => setPicking(true)}>
              <CalendarDays className="size-4 text-muted-foreground" />
              <span className="flex-1">
                {t('bots.items.snooze.pickCustom', 'Pick a date and time')}
              </span>
              <ChevronRight className="size-4 text-muted-foreground" />
            </button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
