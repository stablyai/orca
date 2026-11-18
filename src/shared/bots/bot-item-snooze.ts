// Snoozing an item: the owner hides it until a time, keeping its status. The presets resolve in the
// snoozing device's own time zone; the host stores the instant.

/** The latest a snooze may reach, so a typo can't hide an item for years. */
export const BOT_ITEM_SNOOZE_MAX_MS = 366 * 24 * 60 * 60_000

export type BotItemSnoozePresetId = 'later' | 'tomorrow' | 'monday'

export type BotItemSnoozePreset = {
  id: BotItemSnoozePresetId
  at: number
  /** Later today in the evening reads "In 3 hours"; otherwise the preset's own name. */
  inHours?: number
}

const MORNING_HOUR = 9
const EVENING_HOUR = 18
// Past this hour, 6 PM is too close to be "later", so Later today is three hours out.
const LATER_CUTOFF_HOUR = 17
const LATER_HOURS = 3

function at(day: Date, hour: number): number {
  const time = new Date(day)
  time.setHours(hour, 0, 0, 0)
  return time.getTime()
}

/** Later today, Tomorrow 9 AM and Monday 9 AM (next Monday on a Monday), from `now` local time. */
export function botItemSnoozePresets(now: number): BotItemSnoozePreset[] {
  const today = new Date(now)
  const later: BotItemSnoozePreset =
    today.getHours() < LATER_CUTOFF_HOUR
      ? { id: 'later', at: at(today, EVENING_HOUR) }
      : {
          id: 'later',
          at: at(today, today.getHours() + LATER_HOURS + (today.getMinutes() > 0 ? 1 : 0)),
          inHours: LATER_HOURS
        }
  const tomorrow = new Date(today)
  tomorrow.setDate(today.getDate() + 1)
  const monday = new Date(today)
  monday.setDate(today.getDate() + ((8 - today.getDay()) % 7 || 7))
  return [
    later,
    { id: 'tomorrow', at: at(tomorrow, MORNING_HOUR) },
    { id: 'monday', at: at(monday, MORNING_HOUR) }
  ]
}

/** How a wake time reads: "6:00 PM" today, "Thu 9:00 AM" within the week, else "Nov 30, 9:00 AM". */
export function botItemSnoozeTimeFormat(until: number, now: number): Intl.DateTimeFormatOptions {
  const time = { hour: 'numeric', minute: '2-digit' } as const
  const day = new Date(until)
  const today = new Date(now)
  if (day.toDateString() === today.toDateString()) {
    return time
  }
  return until - now < 6 * 24 * 60 * 60_000
    ? { weekday: 'short', ...time }
    : { month: 'short', day: 'numeric', ...time }
}

type Translate = (key: string, fallback: string, values?: Record<string, unknown>) => string

/** A preset's name in menus and sheets. */
export function botItemSnoozePresetName(preset: BotItemSnoozePreset, t: Translate): string {
  switch (preset.id) {
    case 'later':
      return preset.inHours
        ? t('bots.items.snooze.inHours', 'In {{count}} hours', { count: preset.inHours })
        : t('bots.items.snooze.later', 'Later today')
    case 'tomorrow':
      return t('bots.items.snooze.tomorrow', 'Tomorrow')
    case 'monday':
      return t('bots.items.snooze.monday', 'Monday')
  }
}
