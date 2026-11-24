// The Automations section's rows: Look around, Tidy memory, automations and waits, one line each. The
// leading icon is the state (failed, can't run, running, paused), details sit in the hover card, and
// Pause/Resume, Run now and the row's other commands show on hover or focus. Folded, only trouble stays.
import { useLayoutEffect, useState } from 'react'
import { botTarget } from '@/lib/bot-hosts'
import {
  ArrowUpRight,
  CalendarClock,
  CirclePlay,
  Hourglass,
  Moon,
  Settings,
  Trash2,
  Zap
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import { useTranslate } from '@/i18n/use-translate'
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
import type { BotAutomationCardRow } from './bot-automation-card'
import {
  automationEnabled,
  botAutomationMembershipState,
  type AutomationEnabledOverride,
  type AutomationOverrideOwner,
  type BotAutomationMembership,
  type NormalAutomationCardRow
} from './bot-automation-row-membership'
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
  type BotRowMenuItem,
  type BotRowState
} from './BotPanelRow'
import { LookAroundRow } from './BotLookAroundRow'
import {
  ICON,
  paused,
  pauseResume,
  PauseResumeButton,
  updateBotReporting
} from './bot-automation-row-controls'

const HOUR = { hour: 'numeric' } as const

function tidyHour(hour: number): string {
  return uiDateTimeFormat(HOUR).format(new Date(2000, 0, 1, hour))
}

function TidyUpRow({ bot, folded }: { bot: Bot; folded: boolean }): React.JSX.Element | null {
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
      rowKey="tidy-up"
      icon={<BotRowStateIcon state={rowState} kind={<Moon className={ICON} />} />}
      title={t('bots.upcoming.tidyUp', 'Tidy memory')}
      state={rowState?.label}
      dimmed={!setting.on}
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

/** Delete on an automation row: its state while deleting, and how to ask for it. */
export type BotAutomationRowDeletion = {
  pending: boolean
  /** Keep a row that was in trouble at admission visible while folded and pending. */
  admittedAsTrouble: boolean
  /** Offline or deleting. */
  disabled: boolean
  request: () => void
  /** The visit and Activity authority showing this row; null before a read lands. */
  owner: AutomationOverrideOwner | null
  commitSaved: (rowKey: string, saved: AutomationEnabledOverride | null) => void
}

/** A click opens it on the Automations page, at its failed run if it failed. */
function AutomationRow({
  card,
  membership,
  now,
  folded,
  deletion
}: {
  card: NormalAutomationCardRow
  membership: BotAutomationMembership
  now: number
  folded: boolean
  deletion: BotAutomationRowDeletion | null
}): React.JSX.Element | null {
  const t = useTranslate()
  const row = card.row
  const { automation } = row
  const { bot } = membership
  const [saving, setSaving] = useState(false)
  const [starting, setStarting] = useState(false)
  // The saved state until the list re-reads; a newer record from the host replaces it.
  const [saved, setSaved] = useState<AutomationEnabledOverride | null>(null)
  const commitSaved = deletion?.commitSaved
  const rowKey = card.key
  useLayoutEffect(() => {
    if (commitSaved && saved) {
      commitSaved(rowKey, saved)
      return () => commitSaved(rowKey, null)
    }
    return undefined
  }, [commitSaved, rowKey, saved])
  const owner = deletion?.owner ?? null
  const enabled = automationEnabled(automation, saved, owner)
  const membershipState = botAutomationMembershipState(card, membership, t, enabled)
  const trouble = isBotRowTrouble(membershipState)
  const pending = deletion?.pending === true
  if (folded && !trouble && !(pending && deletion?.admittedAsTrouble)) {
    return null
  }
  const rowState: BotRowState | null = pending
    ? { kind: 'deleting', label: t('bots.automations.deleting', 'Deleting…') }
    : membershipState
  const when = botAutomationWhen(automation)
  const setEnabled = (next: boolean): void => {
    // Owned by what showed the row when asked: a reply after a re-pair cannot speak for the new one.
    const asked = owner
    const from = automation.updatedAt
    setSaving(true)
    void updateAutomationForTarget(automation, { enabled: next }, botTarget(bot))
      .then((updated) => setSaved(asked ? { enabled: updated.enabled, from, owner: asked } : null))
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
  const toggle = pauseResume(t, enabled, setEnabled, saving || pending)
  const deleteItem: BotRowMenuItem | null = deletion
    ? {
        icon: <Trash2 />,
        label: t('auto.components.automations.AutomationsPage.15e0bfb13b', 'Delete'),
        onSelect: deletion.request,
        disabled: deletion.disabled,
        variant: 'destructive'
      }
    : null
  const kind = hasAutomationSchedule(automation) ? (
    <CalendarClock className={ICON} />
  ) : (
    <Zap className={ICON} />
  )
  return (
    <BotPanelRow
      rowKey={card.key}
      icon={<BotRowStateIcon state={rowState} kind={kind} />}
      title={automation.name}
      state={rowState?.label}
      dimmed={rowState?.kind === 'paused'}
      // An event-only row has no next; one whose events won't fire still runs on its schedule.
      next={!pending && enabled && card.nextAt !== null ? { at: card.nextAt, now } : null}
      card={{
        state: rowState,
        facts: pending
          ? []
          : [
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
      contextMenu={deleteItem ? [deleteItem] : undefined}
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
                  disabled: starting || pending
                },
                toggle
              ],
              [
                {
                  icon: <ArrowUpRight />,
                  label: t('bots.automations.openOnPage', 'Open on Automations page'),
                  onSelect: () => openBotAutomation(bot.hostId, automation.id, null)
                }
              ],
              deleteItem ? [deleteItem] : []
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
      rowKey={`wait:${row.key}`}
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
  membership,
  row,
  upNext,
  now,
  folded,
  deletion
}: {
  membership: BotAutomationMembership
  row: BotAutomationCardRow
  upNext: UpNextState | undefined
  now: number
  /** The section is folded: only rows in trouble render. */
  folded: boolean
  /** Delete for an automation row; none elsewhere. */
  deletion?: BotAutomationRowDeletion | null
}): React.JSX.Element | null {
  const { bot } = membership
  switch (row.kind) {
    case 'look-around':
      return <LookAroundRow bot={bot} row={row} state={upNext} now={now} folded={folded} />
    case 'tidy-up':
      // Its next run is a window, or whenever this computer wakes after one, so it says no time.
      return <TidyUpRow bot={bot} folded={folded} />
    case 'automation':
      return (
        <AutomationRow
          card={row}
          membership={membership}
          now={now}
          folded={folded}
          deletion={deletion ?? null}
        />
      )
    case 'wait':
      return <WaitRow bot={bot} row={row.row} folded={folded} />
  }
}
