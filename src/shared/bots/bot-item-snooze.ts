// Snoozing an item: the owner hides it until a time, keeping its status. The presets resolve in the
// snoozing device's own time zone; the host stores the instant.

/** The latest a snooze may reach, so a typo can't hide an item for years. */
export const BOT_ITEM_SNOOZE_MAX_MS = 366 * 24 * 60 * 60_000

export type BotItemSnoozePresetId = 'later' | 'tomorrow' | 'monday' | 'week'

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

/** The desktop picker's presets: the menu's three, then the same time of morning a week out. On a
 *  Monday both land on next Monday, so only In a week stays. */
export function botItemSnoozePickerPresets(now: number): BotItemSnoozePreset[] {
  const week = new Date(now)
  week.setDate(week.getDate() + 7)
  const inAWeek = at(week, MORNING_HOUR)
  return [
    ...botItemSnoozePresets(now).filter((preset) => preset.at !== inAWeek),
    { id: 'week', at: inAWeek }
  ]
}

export const BOT_ITEM_SNOOZE_SLOT_MINUTES = 15
export const BOT_ITEM_SNOOZE_DEFAULT_MINUTES = MORNING_HOUR * 60

/** `minutes` past local midnight of `day`'s date. */
export function botItemSnoozeAt(day: Date, minutes: number): number {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes).getTime()
}

/** Quarter hours on `day` still ahead of `now` and within the cap; a DST gap's hour has none. */
export function botItemSnoozeSlots(day: Date, now: number): number[] {
  const slots: number[] = []
  for (let minutes = 0; minutes < 24 * 60; minutes += BOT_ITEM_SNOOZE_SLOT_MINUTES) {
    const until = botItemSnoozeAt(day, minutes)
    const wall = new Date(until)
    if (
      until > now &&
      until <= now + BOT_ITEM_SNOOZE_MAX_MS &&
      wall.getHours() * 60 + wall.getMinutes() === minutes
    ) {
      slots.push(minutes)
    }
  }
  return slots
}

/** `minutes` if that slot is still open on `day`, else the next open one; null when the day has none. */
export function botItemSnoozeSlotOn(day: Date, minutes: number, now: number): number | null {
  const slots = botItemSnoozeSlots(day, now)
  return slots.find((slot) => slot >= minutes) ?? slots.at(-1) ?? null
}

/** The first and last days with an open slot, at local midnight. */
export function botItemSnoozeDayRange(now: number): { first: Date; last: Date } {
  const first = new Date(now)
  first.setHours(0, 0, 0, 0)
  if (botItemSnoozeSlots(first, now).length === 0) {
    first.setDate(first.getDate() + 1)
  }
  const last = new Date(now + BOT_ITEM_SNOOZE_MAX_MS)
  last.setHours(0, 0, 0, 0)
  return { first, last }
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
    case 'week':
      return t('bots.items.snooze.week', 'In a week')
  }
}
