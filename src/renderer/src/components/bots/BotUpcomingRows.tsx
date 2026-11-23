// The Automations section's rows: Look around, Tidy memory, automations and waits, one line each. The
// leading icon is the state (failed, can't run, running, paused), details sit in the hover card, and
// Pause/Resume, Run now and the row's other commands show on hover or focus. Folded, only trouble stays.
import { useState } from 'react'
import { botTarget } from '@/lib/bot-hosts'
import {
  ArrowUpRight,
  CalendarClock,
  CirclePlay,
  Hourglass,
  Moon,
  Settings,
  Zap
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import { useTranslate } from '@/i18n/use-translate'
import { useBotWebhooks } from '@/lib/bot-catalog'
import { hasAutomationSchedule } from '../../../../shared/automation-event-triggers'
import type { Bot } from '../../../../shared/bot-types'
import type { BotAutomationRow } from '../../../../shared/bots/bot-automation-rows'
import type { UpNextState } from '../../../../shared/bots/bot-look-around'
import { botTidyUp, TIDY_UP_HOURS } from '../../../../shared/bots/bot-tidy-up'
import {
  deleteAutomationForTarget,
  runAutomationNowForTarget,
  updateAutomationForTarget
} from '../automations/hosts/automation-host-client'
import { automationWontFire } from '../automations/details/automation-wont-fire'
import type { BotAutomationCardRow } from './bot-automation-card'
import { openBotAutomation } from './bot-automation-open'
import { botAutomationWhen } from './bot-automation-when'
import { botErrorMessage } from './bot-presentation'
import { openBotSettings } from './bot-settings-open'
import { ranText, upcomingAt } from './bot-upcoming-copy'
import { waitRowDetail } from './bot-wait-copy'
import {
  BotPanelRow,
  BotRowMoreMenu,
  BotRowStateIcon,
  isBotRowTrouble,
  type BotRowState
} from './BotPanelRow'
import { LookAroundRow } from './BotLookAroundRow'
import {
  ICON,
  paused,
  pauseResume,
  PauseResumeButton,
  updateBotReporting,
  wontFireState
} from './bot-automation-row-controls'
import { useOrcaCloudSignedOut } from './orca-cloud-signed-out'

const HOUR = { hour: 'numeric' } as const

function tidyHour(hour: number): string {
  return uiDateTimeFormat(HOUR).format(new Date(2000, 0, 1, hour))
}

function TidyUpRow({
  bot,
  row,
  now,
  folded
}: {
  bot: Bot
  row: BotAutomationCardRow
  now: number
  folded: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  if (folded) {
    return null
  }
  const setting = botTidyUp(bot)
  const rowState = setting.on ? null : paused(t)
  const hours = { from: tidyHour(TIDY_UP_HOURS.from) }
  const toggle = pauseResume(t, setting.on, (on) => updateBotReporting(bot, { tidyUp: { on } }))
  return (
    <BotPanelRow
      icon={<BotRowStateIcon state={rowState} kind={<Moon className={ICON} />} />}
      title={t('bots.upcoming.tidyUp', 'Tidy memory')}
      state={rowState?.label}
      dimmed={!setting.on}
      next={setting.on && row.nextAt !== null ? { at: row.nextAt, now } : null}
      card={{
        state: rowState,
        facts: [
          {
            text:
              setting.every === 'night'
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
        ]
      }}
      onOpen={() => openBotSettings(bot.id, 'tidy-up')}
      actions={
        <>
          <PauseResumeButton item={toggle} />
          <BotRowMoreMenu
            groups={[
              [toggle],
              [
                {
                  icon: <Settings />,
                  label: t('bots.upcoming.tidySettings', 'Tidy memory settings'),
                  onSelect: () => openBotSettings(bot.id, 'tidy-up')
                }
              ]
            ]}
          />
        </>
      }
    />
  )
}

/** A click opens it on the Automations page, at its failed run if it failed. */
function AutomationRow({
  card,
  row,
  bot,
  signInShownApart,
  now,
  folded
}: {
  card: BotAutomationCardRow
  row: BotAutomationRow
  bot: Bot
  /** Its sign-in stop is listed in Needs you, so the row doesn't say it again. */
  signInShownApart: boolean
  now: number
  folded: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const { automation } = row
  const wontFire = automationWontFire(
    automation,
    [bot],
    useBotWebhooks(bot.hostId),
    useOrcaCloudSignedOut()
  )
  const [saving, setSaving] = useState(false)
  const [starting, setStarting] = useState(false)
  // The saved state until the list re-reads; a newer record from the host replaces it.
  const [saved, setSaved] = useState<{ enabled: boolean; from: number } | null>(null)
  const enabled = saved?.from === automation.updatedAt ? saved.enabled : automation.enabled
  const rowState: BotRowState | null =
    !enabled && !card.running
      ? paused(t)
      : card.failed
        ? { kind: 'failed', label: t('bots.automations.failed', 'Failed') }
        : card.running
          ? { kind: 'running', label: t('bots.automations.running', 'Running') }
          : wontFire
            ? wontFireState(wontFire.label)
            : row.needsSignIn && !signInShownApart
              ? {
                  kind: 'alert',
                  label: t('bots.upcoming.needsSignIn', 'Needs sign-in'),
                  reason: t('bots.upcoming.lastNeededSignIn', 'Its last run stopped for a sign-in')
                }
              : null
  if (folded && !isBotRowTrouble(rowState)) {
    return null
  }
  const when = botAutomationWhen(automation)
  const setEnabled = (next: boolean): void => {
    setSaving(true)
    void updateAutomationForTarget(automation, { enabled: next }, botTarget(bot))
      .then((updated) => setSaved({ enabled: updated.enabled, from: automation.updatedAt }))
      .catch((error: unknown) => toast.error(botErrorMessage(error)))
      .finally(() => setSaving(false))
  }
  const runNow = (): void => {
    setStarting(true)
    void runAutomationNowForTarget(automation, botTarget(bot))
      .then(() =>
        toast.message(
          t('auto.components.automations.AutomationsPage.a1bdb57008', 'Automation run queued.')
        )
      )
      .catch((error: unknown) => toast.error(botErrorMessage(error)))
      .finally(() => setStarting(false))
  }
  const open = (): void =>
    openBotAutomation(bot.hostId, automation.id, card.failed ? (row.latestRunId ?? null) : null)
  const toggle = pauseResume(t, enabled, setEnabled, saving)
  const kind = hasAutomationSchedule(automation) ? (
    <CalendarClock className={ICON} />
  ) : (
    <Zap className={ICON} />
  )
  return (
    <BotPanelRow
      icon={<BotRowStateIcon state={rowState} kind={kind} />}
      title={automation.name}
      state={rowState?.label}
      dimmed={rowState?.kind === 'paused'}
      // A row that won't fire says so instead of a time it won't keep.
      next={enabled && !wontFire && card.nextAt !== null ? { at: card.nextAt, now } : null}
      card={{
        state: rowState,
        facts: [
          enabled && card.nextAt !== null
            ? {
                label: t('bots.automations.next', 'Next'),
                text: `${upcomingAt(card.nextAt, now)} · ${when}`
              }
            : { text: when },
          ...(card.mark?.kind === 'ran' ? [{ text: ranText(card.mark.at, now) }] : [])
        ]
      }}
      onOpen={open}
      actions={
        <>
          <PauseResumeButton item={toggle} />
          <BotRowMoreMenu
            groups={[
              [
                {
                  icon: <CirclePlay />,
                  label: t('bots.automations.runNow', 'Run now'),
                  onSelect: runNow,
                  disabled: starting
                },
                toggle
              ],
              [
                {
                  icon: <ArrowUpRight />,
                  label: t('bots.automations.openOnPage', 'Open on Automations page'),
                  onSelect: () => openBotAutomation(bot.hostId, automation.id, null)
                }
              ]
            ]}
          />
        </>
      }
    />
  )
}

/** A wait still waiting; Cancel deletes it without running it. */
function WaitRow({
  bot,
  row,
  folded
}: {
  bot: Bot
  row: BotAutomationRow
  folded: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const { automation } = row
  const [cancelling, setCancelling] = useState(false)
  if (folded) {
    return null
  }
  const cancel = (): void => {
    setCancelling(true)
    void deleteAutomationForTarget(automation, botTarget(bot))
      .catch((error: unknown) => toast.error(botErrorMessage(error)))
      .finally(() => setCancelling(false))
  }
  return (
    <BotPanelRow
      icon={<Hourglass className={ICON} />}
      title={automation.name}
      card={
        automation.once ? { state: null, facts: [{ text: waitRowDetail(automation.once) }] } : null
      }
      actionsShown={cancelling}
      actions={
        <Button
          variant="ghost"
          size="xs"
          className="h-6"
          disabled={cancelling}
          onClick={cancel}
          aria-label={t('bots.waits.cancelNamed', 'Cancel waiting for {{name}}', {
            name: automation.name
          })}
        >
          {t('bots.waits.cancel', 'Cancel')}
        </Button>
      }
    />
  )
}

export function UpcomingItem({
  bot,
  row,
  upNext,
  signInStops,
  now,
  folded
}: {
  bot: Bot
  row: BotAutomationCardRow
  upNext: UpNextState | undefined
  signInStops: ReadonlySet<string>
  now: number
  /** The section is folded: only rows in trouble render. */
  folded: boolean
}): React.JSX.Element | null {
  switch (row.kind) {
    case 'look-around':
      return <LookAroundRow bot={bot} row={row} state={upNext} now={now} folded={folded} />
    case 'tidy-up':
      return <TidyUpRow bot={bot} row={row} now={now} folded={folded} />
    case 'automation':
      return (
        <AutomationRow
          bot={bot}
          card={row}
          row={row.row}
          signInShownApart={signInStops.has(row.row.key)}
          now={now}
          folded={folded}
        />
      )
    case 'wait':
      return <WaitRow bot={bot} row={row.row} folded={folded} />
  }
}
