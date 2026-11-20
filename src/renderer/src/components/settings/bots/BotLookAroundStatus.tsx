// Look around's status under its schedule: when the next look is and why, how the last went, what
// it needs from the owner, and Look now. Every time here comes from the host's own decision.
import { lookAroundTimesProblem } from '../../../../../shared/bots/bot-look-around-times'
import { isValidElement } from 'react'
import { Button } from '@/components/ui/button'
import { formatAutomationDateTime } from '@/components/automations/automation-page-parts'
import { upcomingAt } from '@/components/bots/bot-upcoming-copy'
import { useLooking } from '@/components/bots/BotUpNextSection'
import { LookStatusToken } from '@/components/bots/LookStatusToken'
import { foreignZone, lookAroundScheduleShort } from '@/components/bots/bot-look-around-copy'
import { translate } from '@/i18n/i18n'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import { useTranslate } from '@/i18n/use-translate'
import { useNow } from '@/lib/window-activity/use-now'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotLookAround, UpNextState } from '../../../../../shared/bots/bot-look-around'

const CLOCK = { hour: 'numeric', minute: '2-digit' } as const
/** Failed looks in a row at which Settings asks the owner to step in; the host's badge agrees. */
const NEEDS_YOU = 3
const NOT_LOOKED: UpNextState = { running: false, seenAt: 0 }

const clock = (at: number): string => uiDateTimeFormat(CLOCK).format(at)

/** "Today, 12:04 PM · took 3 min · 4 suggestions". */
function lastLookedText(state: UpNextState, count: number): string | null {
  if (!state.lastLookedAt) {
    return null
  }
  if (state.error) {
    // How long it took and what it found belong to an earlier look, not this one.
    return `${formatAutomationDateTime(state.lastLookedAt)} · ${translate('settings.bots.lookAround.lastFailed', 'didn’t finish')}`
  }
  const minutes = Math.max(1, Math.round((state.tookMs ?? 0) / 60_000))
  return [
    formatAutomationDateTime(state.lastLookedAt),
    translate('settings.bots.lookAround.took', 'took {{value}} min', { value: minutes }),
    translate('settings.bots.lookAround.suggestions', '{{value}} suggestions', { value: count })
  ].join(' · ')
}

function nextText(setting: BotLookAround, state: UpNextState, now: number, where: string): string {
  if (state.running) {
    return translate('settings.bots.lookAround.lookingNow', 'Looking now…')
  }
  if (state.nextHeld && state.nextGraceEndsAt) {
    return translate(
      'settings.bots.lookAround.nextHeld',
      'Waiting for {{where}} to finish waking up. This look runs if it’s ready by {{graceEnd}}; otherwise it’s skipped.',
      { where, graceEnd: clock(state.nextGraceEndsAt) }
    )
  }
  if (state.dueNow) {
    return translate('settings.bots.lookAround.nextDue', 'Due now · starting within a minute')
  }
  if (state.nextAt) {
    const when = upcomingAt(state.nextAt, now)
    return foreignZone(state.timeZone)
      ? translate('settings.bots.lookAround.nextYourTime', '{{when}} your time', { when })
      : when
  }
  if (setting.every === 'custom' && lookAroundTimesProblem(setting.times ?? [])) {
    return translate(
      'settings.bots.lookAround.needsTimes',
      'Pick valid times to start looking around.'
    )
  }
  return translate(
    'settings.bots.lookAround.nextAfterFirstChat',
    'After your first chat, then {{every}}',
    {
      every: lookAroundScheduleShort(setting)
    }
  )
}

export function BotLookAroundStatus({
  bot,
  setting,
  state = NOT_LOOKED,
  suggestions,
  unsaved,
  where,
  needsYou
}: {
  bot: Bot
  setting: BotLookAround
  state: UpNextState | undefined
  suggestions: number
  /** The owner's edit isn't saved, so Next look still follows the saved schedule. */
  unsaved: boolean
  /** "this computer", or the paired server's name. */
  where: string
  /** The host says the owner should step in (failing, or one slot failing or missed). */
  needsYou: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const now = useNow(60_000)
  const { looking, lookNowClicked } = useLooking(bot, state)
  const last = lastLookedText(state, suggestions)
  const failed = state.failedInARow ?? 0
  const notes: React.ReactNode[] = []
  if (state.lastLateFor !== undefined) {
    notes.push(
      <span key="late" className="flex flex-wrap items-center gap-1.5">
        <LookStatusToken severity="info">
          {t('settings.bots.lookAround.ranLate', 'Ran late')}
        </LookStatusToken>
        {t(
          'settings.bots.lookAround.ranLateWhy',
          'The {{time}} look waited for {{where}} to finish waking up before it started.',
          { where, time: clock(state.lastLateFor) }
        )}
      </span>
    )
  }
  if (failed >= NEEDS_YOU) {
    notes.push(
      <span key="failing" className="flex flex-wrap items-center gap-1.5">
        <LookStatusToken severity="need">
          {t('settings.bots.lookAround.failedInARow', '{{count}} looks failed in a row', {
            count: failed
          })}
        </LookStatusToken>
        {t(
          'settings.bots.lookAround.failedTurnsOff',
          'Look around turns itself off after 10 in a row.'
        )}
      </span>
    )
  }
  if (state.error) {
    notes.push(<span key="error">{state.error}</span>)
  }
  const repeat = state.repeatTrouble
  // Nothing records sleep, so a miss never claims the machine was asleep.
  const whyMissed = t(
    'settings.bots.lookAround.whyMissed',
    'Orca wasn’t running or {{where}} was asleep.',
    { where }
  )
  if (state.missedAt !== undefined && !repeat) {
    notes.push(
      <span key="missed" className="flex flex-wrap items-center gap-1.5">
        <LookStatusToken severity="info">
          {t('settings.bots.lookAround.missedToken', 'Missed')}
        </LookStatusToken>
        {t('settings.bots.lookAround.missed', 'The {{time}} look didn’t run.', {
          time: clock(state.missedAt)
        })}{' '}
        {whyMissed}
      </span>
    )
  }
  if (repeat) {
    const time = clock(repeat.scheduledFor)
    const count = repeat.failed + repeat.missed
    notes.push(
      <span key="repeat" className="flex flex-wrap items-center gap-1.5">
        {needsYou && failed < NEEDS_YOU ? (
          <LookStatusToken severity="need">
            {t('bots.lookAround.needsYou', 'Needs you')}
          </LookStatusToken>
        ) : null}
        {repeat.missed === 0
          ? t(
              'settings.bots.lookAround.repeatFailed',
              'The {{time}} look failed on {{count}} of its last {{of}} scheduled days.',
              { time, count, of: repeat.of }
            )
          : repeat.failed === 0
            ? `${t(
                'settings.bots.lookAround.repeatMissed',
                'The {{time}} look didn’t run on {{count}} of its last {{of}} scheduled days.',
                { time, count, of: repeat.of }
              )} ${whyMissed}`
            : t(
                'settings.bots.lookAround.repeatTrouble',
                'The {{time}} look failed or didn’t run on {{count}} of its last {{of}} scheduled days.',
                { time, count, of: repeat.of }
              )}
      </span>
    )
  }
  return (
    <div
      className="flex flex-col gap-3 rounded-md border border-border p-3 @[28rem]:flex-row @[28rem]:items-start"
      aria-live="polite"
    >
      <div className="min-w-0 flex-1 space-y-2 text-xs text-muted-foreground">
        <div>
          <div className="text-sm font-medium text-foreground">
            {t('settings.bots.lookAround.nextLook', 'Next look')}
            {unsaved ? (
              <span className="ml-1.5 text-[11px] font-medium text-destructive">
                {t('settings.bots.lookAround.unsaved', '· your change isn’t saved')}
              </span>
            ) : null}
          </div>
          <div>{nextText(setting, state, now, where)}</div>
          {state.nextSkipped && !state.running ? (
            <div>
              {t(
                'settings.bots.lookAround.skipped',
                'The {{time}} look is skipped because you looked at {{lookedAt}}.',
                { time: clock(state.nextSkipped.at), lookedAt: clock(state.nextSkipped.lookedAt) }
              )}
            </div>
          ) : null}
        </div>
        {last || notes.length > 0 ? (
          <div>
            <div className="text-sm font-medium text-foreground">
              {t('settings.bots.lookAround.lastLook', 'Last look')}
            </div>
            {last ? <div>{last}</div> : null}
            {notes.map((note) => (
              <div key={isValidElement(note) ? note.key : null} className="mt-1">
                {note}
              </div>
            ))}
          </div>
        ) : null}
        {bot.paused ? (
          <p>
            {t(
              'settings.bots.lookAround.pausedNoLooks',
              'The bot is paused, so it doesn’t look around.'
            )}
          </p>
        ) : null}
        <p>
          {state.catchUp
            ? t(
                'settings.bots.lookAround.requirementsCatchUp',
                'Orca must be running and {{where}} awake. A missed look runs once when it wakes, the same day.',
                { where }
              )
            : t(
                'settings.bots.lookAround.requirements',
                'Orca must be running and {{where}} awake at each time. A look missed by more than an hour is skipped.',
                { where }
              )}
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        disabled={looking || bot.paused}
        onClick={lookNowClicked}
      >
        {looking
          ? t('settings.bots.lookAround.looking', 'Looking…')
          : t('bots.upNext.lookNow', 'Look now')}
      </Button>
    </div>
  )
}
