// The bot's Look around in its sidebar card: when it looks next, or what it needs; opens its settings.
import { ChevronRight, CircleAlert, Eye } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import type { Bot } from '../../../../shared/bot-types'
import { botLookAround, lookAroundSupported } from '../../../../shared/bots/bot-look-around'
import { foreignZone, lookAroundScheduleShort } from './bot-look-around-copy'
import { openBotSettings } from './bot-settings-open'
import { upcomingAt } from './bot-upcoming-copy'
import { LookStatusToken } from './LookStatusToken'
import { useLookAroundFailing, useLookAroundStatus } from './use-look-around-status'

const CLOCK = { hour: 'numeric', minute: '2-digit' } as const

export function BotHoverLookLine({ bot }: { bot: Bot }): React.JSX.Element | null {
  const t = useTranslate()
  const status = useLookAroundStatus(bot)
  const failing = useLookAroundFailing(bot)
  if (!lookAroundSupported(bot.agent)) {
    return null
  }
  const setting = botLookAround(bot)
  const state = status?.upNext
  const needsYou = failing > 0
  // Which kind of trouble it is: looks that failed in a row, or one time that keeps not running.
  const needsYouText = (): string => {
    const repeat = state?.repeatTrouble
    if ((state?.failedInARow ?? 0) >= failing || !repeat) {
      return t('bots.lookAround.hoverFailing', 'Look around · {{count}} looks failed', {
        count: failing
      })
    }
    const time = uiDateTimeFormat(CLOCK).format(repeat.scheduledFor)
    const count = repeat.failed + repeat.missed
    return repeat.failed === 0
      ? t('bots.lookAround.hoverMissed', 'Look around · {{time}} didn’t run {{count}} days', {
          time,
          count
        })
      : t(
          'bots.lookAround.hoverTrouble',
          'Look around · {{time}} failed or didn’t run {{count}} days',
          {
            time,
            count
          }
        )
  }
  const text = !setting.on
    ? needsYou
      ? t('bots.lookAround.hoverTurnedOff', 'Look around turned itself off')
      : t('bots.lookAround.hoverOff', 'Look around is off')
    : needsYou
      ? needsYouText()
      : state?.running
        ? t('bots.lookAround.hoverLooking', 'Looking around now')
        : state?.nextAt
          ? t('bots.lookAround.hoverNext', 'Looks around {{every}} · next {{when}}', {
              every: lookAroundScheduleShort(setting, foreignZone(state.timeZone)),
              when: upcomingAt(state.nextAt)
            })
          : t('bots.lookAround.hoverEvery', 'Looks around {{every}}', {
              every: lookAroundScheduleShort(setting)
            })
  return (
    <button
      type="button"
      title={text}
      aria-label={needsYou ? `${text} · ${t('bots.lookAround.needsYou', 'Needs you')}` : text}
      className="-mx-1.5 mt-2 flex w-[calc(100%+0.75rem)] min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      onClick={() => openBotSettings(bot.id, 'look-around')}
    >
      <Eye className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {needsYou ? (
        <LookStatusToken severity="need">
          {t('bots.lookAround.needsYou', 'Needs you')}
        </LookStatusToken>
      ) : setting.on && state?.lastLateFor !== undefined ? (
        <LookStatusToken severity="info">
          {t('settings.bots.lookAround.ranLate', 'Ran late')}
        </LookStatusToken>
      ) : null}
      <ChevronRight className="size-3.5 shrink-0" aria-hidden />
    </button>
  )
}

/** On the sidebar row only while Look around needs the owner: failing, or turned off by failures. */
export function BotLookNeedsYouBadge({ bot }: { bot: Bot }): React.JSX.Element {
  const t = useTranslate()
  const label = botLookAround(bot).on
    ? t('bots.lookAround.badge', 'Look around needs you')
    : t('bots.lookAround.badgeTurnedOff', 'Look around turned itself off')
  return (
    <button
      type="button"
      className="flex size-4 shrink-0 items-center justify-center rounded-sm text-destructive hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation()
        openBotSettings(bot.id, 'look-around')
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <CircleAlert className="size-3.5" aria-hidden />
    </button>
  )
}
