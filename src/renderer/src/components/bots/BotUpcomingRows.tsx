// The Automations card's rows: Look around, Tidy memory, automations and waits, each with its switch
// (waits: Cancel) and how its newest run went.
import { useMemo, useState } from 'react'
import { botTarget } from '@/lib/bot-hosts'
import { CalendarClock, Eye, Hourglass, LoaderCircle, Moon, RefreshCw, Zap } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import { useTranslate } from '@/i18n/use-translate'
import { updateBot, useBotWebhooks } from '@/lib/bot-catalog'
import { cn } from '@/lib/class-names'
import { hasAutomationSchedule } from '../../../../shared/automation-event-triggers'
import type { Bot } from '../../../../shared/bot-types'
import type { BotAutomationRow } from '../../../../shared/bots/bot-automation-rows'
import { botLookAround, type UpNextState } from '../../../../shared/bots/bot-look-around'
import { botTidyUp, TIDY_UP_HOURS } from '../../../../shared/bots/bot-tidy-up'
import type { BotUpdateParams } from '../../../../shared/rpc-contract/bots-params'
import {
  deleteAutomationForTarget,
  updateAutomationForTarget
} from '../automations/hosts/automation-host-client'
import { automationWontFire } from '../automations/details/automation-wont-fire'
import { ActivityRow } from './ActivitySection'
import type { BotAutomationCardRow, BotRunMark } from './bot-automation-card'
import { openBotAutomation } from './bot-automation-open'
import { botAutomationWhen } from './bot-automation-when'
import { botErrorMessage } from './bot-presentation'
import { openBotSettings } from './bot-settings-open'
import { everyText, pausedText, ranText, upcomingAt } from './bot-upcoming-copy'
import { waitRowDetail } from './bot-wait-copy'
import { useLooking } from './BotUpNextSection'
import { useOrcaCloudSignedOut } from './orca-cloud-signed-out'
import { UsageLimitStopMark, usageLimitStopMeta } from './BotUsageLimitMark'
import { useBotUsageLimitStops, type BotUsageLimitStop } from './use-bot-usage-limit-stops'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'

const ICON = 'size-4 text-muted-foreground'

/** Hidden exactly while Look now shows: the row hovered, or the button itself focused. */
export const LOOK_NOW_SHOWN_HIDES =
  'group-hover/upcoming:invisible group-has-[[data-look-now]:focus-within]/upcoming:invisible'

/** The stop of the bot's last look, read from its host's status feed like its chats'. */
function useLastLookStop(bot: Bot, sessionId: string | undefined): BotUsageLimitStop | null {
  const homes = useMemo(() => [folderWorkspaceKey(bot.folderWorkspaceId)], [bot.folderWorkspaceId])
  const stops = useBotUsageLimitStops(bot, homes)
  return sessionId ? (stops.find((stop) => stop.sessionId === sessionId) ?? null) : null
}

const NOT_LOOKED: UpNextState = { running: false, seenAt: 0 }

function updateBotReporting(bot: Bot, updates: BotUpdateParams['updates']): void {
  void updateBot(bot, updates).catch((error: unknown) => toast.error(botErrorMessage(error)))
}

/** How the newest run went: failure and running always show; a success drops out when narrow. */
function RunMark({
  mark,
  now,
  className
}: {
  mark: BotRunMark | null
  now: number
  className?: string
}): React.JSX.Element | null {
  const t = useTranslate()
  if (!mark) {
    return null
  }
  switch (mark.kind) {
    case 'failed':
      return (
        <span className={cn('shrink-0 text-2xs font-medium text-destructive', className)}>
          {t('bots.automations.failed', 'Failed')}
        </span>
      )
    case 'running':
      return (
        <span className={cn('shrink-0 text-2xs font-medium text-foreground', className)}>
          {t('bots.automations.running', 'Running')}
        </span>
      )
    case 'ran':
      return (
        <span
          className={cn(
            'shrink-0 text-2xs whitespace-nowrap text-muted-foreground tabular-nums @max-[284px]:hidden',
            className
          )}
        >
          {ranText(mark.at, now)}
        </span>
      )
  }
}

function UpcomingRowFrame({
  on,
  children,
  control
}: {
  on: boolean
  children: React.ReactNode
  control: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="group/upcoming relative flex w-full min-w-0 items-center gap-1 rounded-sm pr-2 hover:bg-accent">
      <div className={cn('flex min-w-0 flex-1', !on && 'opacity-60')}>{children}</div>
      {control}
    </div>
  )
}

function LookAroundRow({
  bot,
  row,
  state,
  now
}: {
  bot: Bot
  row: BotAutomationCardRow
  state: UpNextState | undefined
  now: number
}): React.JSX.Element {
  const t = useTranslate()
  const setting = botLookAround(bot)
  const { looking, lookNowClicked } = useLooking(bot, state ?? NOT_LOOKED)
  // Its last look stopped on the usage limit: the stop says so in place of Failed and its note.
  const stop = useLastLookStop(bot, looking ? undefined : state?.lastSessionId)
  const every = everyText(setting.every)
  const detail = !setting.on
    ? pausedText()
    : looking
      ? t('bots.upNext.looking', 'Looking around…')
      : state?.dueNow && !state.running
        ? t('bots.upcoming.lookDueNow', 'Due now · {{every}}', { every })
        : row.nextAt !== null
          ? `${upcomingAt(row.nextAt, now)} · ${every}`
          : state?.lastLookedAt
            ? every
            : t('bots.upcoming.lookFirst', 'After your first chat · then {{every}}', { every })
  const name = t('settings.bots.lookAround.title', 'Look around')
  return (
    <UpcomingRowFrame
      on={setting.on}
      control={
        <>
          {setting.on ? (
            // Out of flow, beside the switch: hidden, it takes no room, so "Ran …" lines up with other rows.
            <span
              data-look-now=""
              className="pointer-events-none absolute top-1/2 right-12 -translate-y-1/2 rounded-sm bg-accent opacity-0 transition-opacity group-hover/upcoming:pointer-events-auto group-hover/upcoming:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100"
            >
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t('bots.upNext.lookNow', 'Look now')}
                disabled={looking}
                onClick={lookNowClicked}
              >
                {looking ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
              </Button>
            </span>
          ) : null}
          <Switch
            checked={setting.on}
            onCheckedChange={(on) => updateBotReporting(bot, { lookAround: { on } })}
            aria-label={name}
          />
        </>
      }
    >
      <ActivityRow
        icon={<Eye className={ICON} />}
        title={name}
        aside={
          stop ? (
            <span
              className={cn(
                'flex shrink-0 items-center gap-1 text-2xs font-medium whitespace-nowrap text-status-warning-text',
                setting.on && LOOK_NOW_SHOWN_HIDES
              )}
            >
              <UsageLimitStopMark stop={stop} />
              {usageLimitStopMeta(t, stop)}
            </span>
          ) : (
            <RunMark
              mark={looking ? { kind: 'running' } : row.mark}
              now={now}
              // Look now shows over where the mark ends: the mark steps aside while it does.
              className={setting.on ? LOOK_NOW_SHOWN_HIDES : undefined}
            />
          )
        }
        detail={detail}
        note={setting.on && state?.error && !state.running && !stop ? state.error : undefined}
        onOpen={() => openBotSettings(bot.id, 'look-around')}
      />
    </UpcomingRowFrame>
  )
}

const HOUR = { hour: 'numeric' } as const

function tidyHour(hour: number): string {
  return uiDateTimeFormat(HOUR).format(new Date(2000, 0, 1, hour))
}

function TidyUpRow({ bot }: { bot: Bot }): React.JSX.Element {
  const t = useTranslate()
  const setting = botTidyUp(bot)
  const name = t('bots.upcoming.tidyUp', 'Tidy memory')
  const hours = { from: tidyHour(TIDY_UP_HOURS.from) }
  return (
    <UpcomingRowFrame
      on={setting.on}
      control={
        <Switch
          checked={setting.on}
          onCheckedChange={(on) => updateBotReporting(bot, { tidyUp: { on } })}
          aria-label={name}
        />
      }
    >
      <ActivityRow
        icon={<Moon className={ICON} />}
        title={name}
        detail={
          !setting.on
            ? pausedText()
            : setting.every === 'night'
              ? t(
                  'bots.upcoming.tidyNightAfter',
                  'Each night after {{from}}, or once this computer is awake',
                  hours
                )
              : t(
                  'bots.upcoming.tidyWeekAfter',
                  'Once a week after {{from}}, or once this computer is awake',
                  hours
                )
        }
        onOpen={() => openBotSettings(bot.id, 'tidy-up')}
      />
    </UpcomingRowFrame>
  )
}

/** Its switch pauses and resumes; a click opens it on the Automations page, at its failed run if it failed. */
function AutomationRow({
  card,
  row,
  bot,
  signInShownApart,
  now
}: {
  card: BotAutomationCardRow
  row: BotAutomationRow
  bot: Bot
  /** Its sign-in stop is listed in Needs you, so the row doesn't say it again. */
  signInShownApart: boolean
  now: number
}): React.JSX.Element {
  const t = useTranslate()
  const { automation } = row
  const wontFire = automationWontFire(
    automation,
    [bot],
    useBotWebhooks(bot.hostId),
    useOrcaCloudSignedOut()
  )
  const [saving, setSaving] = useState(false)
  // The saved state until the list re-reads; a newer record from the host replaces it.
  const [saved, setSaved] = useState<{ enabled: boolean; from: number } | null>(null)
  const enabled = saved?.from === automation.updatedAt ? saved.enabled : automation.enabled
  const scheduled = hasAutomationSchedule(automation)
  const when = botAutomationWhen(automation)
  const setEnabled = (next: boolean): void => {
    setSaving(true)
    void updateAutomationForTarget(automation, { enabled: next }, botTarget(bot))
      .then((updated) => setSaved({ enabled: updated.enabled, from: automation.updatedAt }))
      .catch((error: unknown) => toast.error(botErrorMessage(error)))
      .finally(() => setSaving(false))
  }
  return (
    <UpcomingRowFrame
      on={enabled}
      control={
        <Switch
          checked={enabled}
          disabled={saving}
          onCheckedChange={setEnabled}
          aria-label={
            enabled
              ? t('bots.automations.pause', 'Pause {{name}}', { name: automation.name })
              : t('bots.automations.resume', 'Resume {{name}}', { name: automation.name })
          }
        />
      }
    >
      <ActivityRow
        icon={scheduled ? <CalendarClock className={ICON} /> : <Zap className={ICON} />}
        title={automation.name}
        aside={<RunMark mark={enabled || card.running ? card.mark : null} now={now} />}
        detail={
          !enabled
            ? pausedText()
            : card.nextAt !== null
              ? `${upcomingAt(card.nextAt, now)} · ${when}`
              : when
        }
        // A sign-in stop counts in Needs you only while a connector still needs the owner.
        note={
          wontFire?.label ??
          (row.needsSignIn && !signInShownApart
            ? t('bots.upcoming.lastNeededSignIn', 'Its last run stopped for a sign-in')
            : undefined)
        }
        onOpen={() =>
          openBotAutomation(automation.id, card.failed ? (row.latestRunId ?? null) : null)
        }
      />
    </UpcomingRowFrame>
  )
}

/** A wait still waiting; Cancel deletes it without running it. */
function WaitRow({ bot, row }: { bot: Bot; row: BotAutomationRow }): React.JSX.Element {
  const t = useTranslate()
  const { automation } = row
  const [cancelling, setCancelling] = useState(false)
  const cancel = (): void => {
    setCancelling(true)
    void deleteAutomationForTarget(automation, botTarget(bot))
      .catch((error: unknown) => toast.error(botErrorMessage(error)))
      .finally(() => setCancelling(false))
  }
  return (
    <UpcomingRowFrame
      on
      control={
        <Button
          variant="ghost"
          size="xs"
          disabled={cancelling}
          onClick={cancel}
          aria-label={t('bots.waits.cancelNamed', 'Cancel waiting for {{name}}', {
            name: automation.name
          })}
        >
          {t('bots.waits.cancel', 'Cancel')}
        </Button>
      }
    >
      <ActivityRow
        icon={<Hourglass className={ICON} />}
        title={automation.name}
        detail={automation.once ? waitRowDetail(automation.once) : ''}
      />
    </UpcomingRowFrame>
  )
}

export function UpcomingItem({
  bot,
  row,
  upNext,
  signInStops,
  now
}: {
  bot: Bot
  row: BotAutomationCardRow
  upNext: UpNextState | undefined
  signInStops: ReadonlySet<string>
  now: number
}): React.JSX.Element {
  switch (row.kind) {
    case 'look-around':
      return <LookAroundRow bot={bot} row={row} state={upNext} now={now} />
    case 'tidy-up':
      return <TidyUpRow bot={bot} />
    case 'automation':
      return (
        <AutomationRow
          bot={bot}
          card={row}
          row={row.row}
          signInShownApart={signInStops.has(row.row.key)}
          now={now}
        />
      )
    case 'wait':
      return <WaitRow bot={bot} row={row.row} />
  }
}
