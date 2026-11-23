// Look around in the Automations section: looking spins, a failed or usage-limit-stopped look shows as
// trouble, Look now on hover or focus, and its settings in the ⋯ menu.
import { botCodedText } from '../../../../shared/bots/bot-failure-copy'
import { useMemo } from 'react'
import { LoaderCircle, RefreshCw, Settings, Eye } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../shared/bot-types'
import { botLookAround, type UpNextState } from '../../../../shared/bots/bot-look-around'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import type { BotAutomationCardRow } from './bot-automation-card'
import { openBotSettings } from './bot-settings-open'
import { everyText, ranText, upcomingAt } from './bot-upcoming-copy'
import {
  BotPanelRow,
  BotRowIconButton,
  BotRowMoreMenu,
  BotRowStateIcon,
  isBotRowTrouble,
  type BotRowMenuItem,
  type BotRowState
} from './BotPanelRow'
import { useLooking } from './BotUpNextSection'
import { usageLimitStopTip } from './BotUsageLimitMark'
import { useBotUsageLimitStops, type BotUsageLimitStop } from './use-bot-usage-limit-stops'
import {
  ICON,
  paused,
  pauseResume,
  PauseResumeButton,
  updateBotReporting
} from './bot-automation-row-controls'

/** The stop of the bot's last look, read from its host's status feed like its chats'. */
function useLastLookStop(bot: Bot, sessionId: string | undefined): BotUsageLimitStop | null {
  const homes = useMemo(() => [folderWorkspaceKey(bot.folderWorkspaceId)], [bot.folderWorkspaceId])
  const stops = useBotUsageLimitStops(bot, homes)
  return sessionId ? (stops.find((stop) => stop.sessionId === sessionId) ?? null) : null
}

const NOT_LOOKED: UpNextState = { running: false, seenAt: 0 }

export function LookAroundRow({
  bot,
  row,
  state,
  now,
  folded
}: {
  bot: Bot
  row: BotAutomationCardRow
  state: UpNextState | undefined
  now: number
  folded: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const setting = botLookAround(bot)
  const { looking, lookNowClicked } = useLooking(bot, state ?? NOT_LOOKED)
  // Its last look stopped on the usage limit: the stop says so in place of Failed.
  const stop = useLastLookStop(bot, looking ? undefined : state?.lastSessionId)
  const rowState: BotRowState | null = !setting.on
    ? paused(t)
    : looking
      ? { kind: 'running', label: t('bots.upNext.lookingShort', 'Looking around') }
      : stop
        ? {
            kind: 'alert',
            label: t('bots.upcoming.stopped', 'Stopped'),
            reason: usageLimitStopTip(t, stop)
          }
        : state?.error && !state.running
          ? {
              kind: 'failed',
              label: t('bots.automations.failed', 'Failed'),
              reason: botCodedText(state.error, state.failure, t)
            }
          : null
  if (folded && !isBotRowTrouble(rowState)) {
    return null
  }
  const every = everyText(setting)
  const dueNow = setting.on && !looking && state?.dueNow === true
  const nextAt = setting.on && !dueNow ? row.nextAt : null
  const name = t('settings.bots.lookAround.title', 'Look around')
  const setOn = (on: boolean): void => updateBotReporting(bot, { lookAround: { on } })
  const toggle = pauseResume(t, setting.on, setOn)
  const lookNow: BotRowMenuItem = {
    icon: <RefreshCw />,
    label: t('bots.upNext.lookNow', 'Look now'),
    onSelect: lookNowClicked,
    disabled: looking
  }
  const settings: BotRowMenuItem = {
    icon: <Settings />,
    label: t('bots.upcoming.lookAroundSettings', 'Look around settings'),
    onSelect: () => openBotSettings(bot.id, 'look-around')
  }
  return (
    <BotPanelRow
      icon={<BotRowStateIcon state={rowState} kind={<Eye className={ICON} />} />}
      title={name}
      state={rowState?.label}
      dimmed={!setting.on}
      next={nextAt === null ? null : { at: nextAt, now }}
      card={{
        state: dueNow ? { kind: 'note', label: t('bots.upcoming.dueNow', 'Due now') } : rowState,
        facts: [
          nextAt !== null
            ? {
                label: t('bots.automations.next', 'Next'),
                text: `${upcomingAt(nextAt, now)} · ${every}`
              }
            : {
                text:
                  state?.lastLookedAt || !setting.on
                    ? t('bots.upcoming.runsEvery', 'Runs {{every}}', { every })
                    : t('bots.upcoming.lookFirst', 'After your first chat · then {{every}}', {
                        every
                      })
              },
          ...(state?.lastLookedAt ? [{ text: ranText(state.lastLookedAt, now) }] : [])
        ]
      }}
      onOpen={() => openBotSettings(bot.id, 'look-around')}
      actionsShown={looking}
      actions={
        <>
          {setting.on ? (
            <BotRowIconButton label={lookNow.label} disabled={looking} onClick={lookNowClicked}>
              {looking ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
            </BotRowIconButton>
          ) : (
            <PauseResumeButton item={toggle} />
          )}
          <BotRowMoreMenu groups={[setting.on ? [lookNow, toggle] : [toggle], [settings]]} />
        </>
      }
    />
  )
}
