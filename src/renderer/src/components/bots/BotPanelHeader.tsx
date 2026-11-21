// The top of a bot's Activity tab: its picture (edited in place), name, what it is doing now or does next,
// and its settings.
import { useMemo, useState } from 'react'
import { Copy, MoreHorizontal, Pause, Play, Settings, Share2 } from 'lucide-react'
import { toast } from 'sonner'
import { AgentStateDot } from '@/components/agent/status/AgentStateDot'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import { updateBot } from '@/lib/bot-catalog'
import { useAppStore } from '@/store'
import { selectFolderWorkspaceOnHost } from '@/store/folder-workspaces/folder-workspace-record-index'
import type { Bot } from '../../../../shared/bot-types'
import type { BotNow } from '../../../../shared/bots/bot-now'
import { lookedDay } from '../../../../shared/bots/bot-look-around'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import type { useBotPictureSetting } from '../settings/bots/use-bot-picture-setting'
import { botErrorMessage } from './bot-presentation'
import { setBotSettingsPlace } from './settings-view/bot-settings-place'
import { BotPictureButton } from './BotPictureButton'
import { BotRowLineText, useBotRowLine } from './BotRowActivityLine'
import { BotShareFlow } from './sharing/BotShareFlow'
import { formatWaitTime } from './bot-wait-copy'
import { useBotWorkerWorkspaces } from './use-bot-worker-statuses'
import { useBotUsageLimitStops } from './use-bot-usage-limit-stops'
import { UsageLimitStopMark } from './BotUsageLimitMark'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'

type BotNowCounts = Pick<BotNow, 'needsYou' | 'working'>

/** What the bot runs next, for the header's Idle line. */
export type BotNextRun = { name: string; at: number }

/** Its automations, for the header's line while its own chat is quiet. */
export type BotQuietFacts = {
  /** The automation a card row says is Running. */
  running: string | null
  /** The soonest exact next run, never one that is running. */
  next: BotNextRun | null
}

const CLOCK = { hour: 'numeric', minute: '2-digit' } as const

/**
 * "Running Mentions triage" while a row says Running, else "Idle · next 8:00 PM · Look around"; `short`
 * ("Next 8:00 PM") is what a narrow panel says instead, so the time shows and the name drops.
 */
export function botQuietLine(
  { running, next }: BotQuietFacts,
  now: number
): { text: string; short: string | null } {
  if (running !== null) {
    return {
      text: translate('bots.panel.runningNamed', 'Running {{name}}', { name: running }),
      short: null
    }
  }
  if (!next) {
    return { text: translate('bots.panel.idle', 'Idle'), short: null }
  }
  const time = uiDateTimeFormat(CLOCK).format(next.at)
  const when =
    lookedDay(next.at, now) === 'today'
      ? time
      : lookedDay(now, next.at) === 'yesterday'
        ? translate('bots.panel.tomorrowAt', 'tomorrow {{time}}', { time })
        : formatWaitTime(next.at, now)
  return {
    text: translate('bots.panel.idleNext', 'Idle · next {{when}} · {{name}}', {
      name: next.name,
      when
    }),
    short: translate('bots.panel.nextAt', 'Next {{when}}', { when })
  }
}

/** The bot's row line, as its sidebar row and the phone say it; else its automations' line. */
function BotNowLine({
  bot,
  home,
  quiet,
  needsYou
}: {
  bot: Bot
  home: FolderWorkspace
  quiet: BotQuietFacts
  needsYou: number
}): React.JSX.Element {
  // Paused and an asking chat's words still come first; its count is the Items tab's.
  const rowLine = useBotRowLine(bot, home, needsYou)
  const { line, now } = rowLine
  // A running automation is live work: its line beats another session's stop, as its mark does.
  const limit = quiet.running === null ? rowLine.limit : null
  if (line || limit) {
    return <BotRowLineText line={line} limit={limit} now={now} />
  }
  const { text, short } = botQuietLine(quiet, now)
  return short === null ? (
    <>{text}</>
  ) : (
    <>
      <span className="@max-[284px]:hidden">{text}</span>
      <span className="hidden @max-[284px]:inline">{short}</span>
    </>
  )
}

const NOTHING_RUNS: BotQuietFacts = { running: null, next: null }

/** The picture's corner while nothing waits or runs: the stopped mark when a chat, worker or run is
 *  held at its usage limit, else Idle, so a stopped bot never reads as fine. */
function QuietMark({ bot, home }: { bot: Bot; home: FolderWorkspace }): React.JSX.Element {
  const { childWorktrees } = useBotWorkerWorkspaces(home)
  const workspaces = useMemo(
    () => [folderWorkspaceKey(home.id), ...childWorktrees.map((worktree) => worktree.id)],
    [home.id, childWorktrees]
  )
  const [stop] = useBotUsageLimitStops(bot, workspaces)
  return stop ? (
    <UsageLimitStopMark stop={stop} className="size-2.5" />
  ) : (
    <AgentStateDot state="idle" title={null} />
  )
}

export function BotPanelHeader({
  bot,
  now,
  quiet = NOTHING_RUNS,
  picture,
  offline = false,
  filter = null
}: {
  bot: Bot
  now: BotNowCounts
  /** Its automations' running and next, said while nothing else is. */
  quiet?: BotQuietFacts
  picture: ReturnType<typeof useBotPictureSetting>
  /** Its server is down: only the gear stays on, so its settings say what is unavailable. */
  offline?: boolean
  /** The Items filter, before the gear. */
  filter?: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const home = useAppStore((state) =>
    selectFolderWorkspaceOnHost(state, bot.folderWorkspaceId, bot.hostId)
  )
  const folderPath = home?.folderPath ?? null
  const settingsLabel = t('bots.row.settings', 'Bot settings…')
  const moreLabel = t('bots.panel.more', 'More')
  const setRightSidebarTab = useAppStore((state) => state.setRightSidebarTab)
  // Settings open in Activity's place, so the gear works from any tab showing this header.
  const openSettings = (): void => {
    setBotSettingsPlace('panel', { botId: bot.id, page: null })
    setRightSidebarTab('bot-activity')
  }
  const [sharing, setSharing] = useState(false)
  return (
    <div className="flex items-center gap-2.5 px-2 pb-1 pt-1 @max-[284px]:gap-1.5">
      <fieldset disabled={offline} className="contents">
        <BotPictureButton
          bot={bot}
          picture={picture}
          avatarClassName="size-9 rounded-[9px] text-base"
          className="rounded-[9px]"
        >
          {bot.paused ? null : (
            <span className="absolute -bottom-1 -right-1 flex size-3.5 items-center justify-center rounded-full bg-sidebar">
              {now.needsYou > 0 || now.working > 0 || quiet.running !== null || !home ? (
                <AgentStateDot
                  state={
                    now.needsYou > 0
                      ? 'waiting'
                      : now.working > 0 || quiet.running !== null
                        ? 'working'
                        : 'idle'
                  }
                  title={null}
                />
              ) : (
                <QuietMark bot={bot} home={home} />
              )}
            </span>
          )}
        </BotPictureButton>
      </fieldset>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold leading-5">{bot.name}</div>
        <div className="truncate text-xs leading-4 text-muted-foreground">
          {home ? <BotNowLine bot={bot} home={home} quiet={quiet} needsYou={now.needsYou} /> : null}
        </div>
      </div>
      {filter}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={settingsLabel}
            data-bot-panel-gear=""
            onClick={openSettings}
          >
            <Settings />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {settingsLabel}
        </TooltipContent>
      </Tooltip>
      <fieldset disabled={offline} className="contents">
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={moreLabel}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {moreLabel}
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() =>
                void updateBot(bot, { paused: !bot.paused }).catch((error: unknown) =>
                  toast.error(botErrorMessage(error))
                )
              }
            >
              {bot.paused ? <Play /> : <Pause />}
              {bot.paused ? t('bots.row.resume', 'Resume bot') : t('bots.row.pause', 'Pause bot')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setSharing(true)}>
              <Share2 />
              {t('bots.share.shareBot', 'Share bot…')}
            </DropdownMenuItem>
            {folderPath ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => window.api.ui.writeClipboardText(folderPath)}>
                  <Copy />
                  {t('bots.row.copyPath', 'Copy Path')}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </fieldset>
      {sharing ? <BotShareFlow bot={bot} onClose={() => setSharing(false)} /> : null}
    </div>
  )
}
