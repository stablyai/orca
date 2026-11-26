// The line under a bot's Look around and Memory upkeep settings, for the desktop and the phone.
import { lookedDay, type BotLookAround } from './bot-look-around'
import { lookAroundEveryLabel } from './bot-look-around-every-label'
import type { BotTidyUp } from './bot-tidy-up'

type Translate = (key: string, fallback: string, values?: Record<string, unknown>) => string

/** The platform's translate and date format. */
export type BotSettingsLineWords = {
  t: Translate
  format: (at: number, options: Intl.DateTimeFormatOptions) => string
}

const CLOCK = { hour: 'numeric', minute: '2-digit' } as const
const DATE = { month: 'short', day: 'numeric' } as const

/** "12:04 PM" today, "yesterday 4:12 PM", then "Oct 29". */
function lookedWhen(at: number, now: number, { t, format }: BotSettingsLineWords): string {
  const day = lookedDay(at, now)
  if (day === 'earlier') {
    return format(at, DATE)
  }
  const time = format(at, CLOCK)
  return day === 'today' ? time : t('bots.settingsPage.yesterdayAt', 'yesterday {{time}}', { time })
}

/** "today", "yesterday", then "Oct 29". */
function tidiedWhen(at: number, now: number, { t, format }: BotSettingsLineWords): string {
  const day = lookedDay(at, now)
  return day === 'today'
    ? t('bots.settingsPage.today', 'today')
    : day === 'yesterday'
      ? t('bots.settingsPage.yesterday', 'yesterday')
      : format(at, DATE)
}

/** "Every 4 hours, 8 AM to 8 PM · last looked 12:04 PM". */
export function botLookAroundLine(
  setting: BotLookAround,
  lastLookedAt: number | undefined,
  words: BotSettingsLineWords,
  now = Date.now()
): string {
  const { t } = words
  if (!setting.on) {
    return t('bots.settingsPage.off', 'Off')
  }
  const every = lookAroundEveryLabel(setting.every, t)
  return lastLookedAt
    ? `${every} · ${t('bots.settingsPage.lastLooked', 'last looked {{when}}', {
        when: lookedWhen(lastLookedAt, now, words)
      })}`
    : every
}

/** "Each night after 3 AM · last tidied today"; `tidyEvery` is the platform's: only the desktop says it waits for its computer. */
export function botTidyUpLine(
  setting: BotTidyUp,
  lastTidiedAt: number | undefined,
  words: BotSettingsLineWords & { tidyEvery: (every: BotTidyUp['every']) => string },
  now = Date.now()
): string {
  const { t } = words
  if (!setting.on) {
    return t('bots.settingsPage.off', 'Off')
  }
  const every = words.tidyEvery(setting.every)
  return lastTidiedAt
    ? `${every} · ${t('bots.settingsPage.lastTidied', 'last tidied {{when}}', {
        when: tidiedWhen(lastTidiedAt, now, words)
      })}`
    : every
}
