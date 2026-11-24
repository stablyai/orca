import { Circle, House, Laptop, Pause, Server, Unplug } from 'lucide-react'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import StatusIndicator from '@/components/sidebar/workspace-card/surface/StatusIndicator'
import { useWorktreeActivityStatus } from '@/components/sidebar/workspace-card/activity/use-worktree-activity-status'
import { useWorktreeAgentRows } from '@/components/sidebar/workspace-card/activity/useWorktreeAgentRows'
import { useTranslate } from '@/i18n/use-translate'
import { useBotHostOffline } from '@/lib/bot-host-views'
import { getWorktreeStatusLabel } from '@/lib/workspace/activity/worktree-status'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { useAppStore } from '@/store'
import { formatAgentToolPreview } from '../../../../shared/agent-status/presentation/agent-row-tool-preview'
import { getAgentRowPrimaryText } from '../../../../shared/agent-status/presentation/agent-row-primary-text'
import { foldBotStatus } from '../../../../shared/bots/bot-row-status'
import type { Bot } from '../../../../shared/bot-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { BotAvatar } from './BotAvatar'
import { BotHoverNeedsYou } from './BotHoverNeedsYou'
import { BotHoverLatestLine, useBotRowLine } from './BotRowActivityLine'
import { useBotSoulDescription } from './bot-soul-description'
import { useBotHostLabel } from './use-bot-host-label'

/** Shared row facts. The collapsed preview reads them only while the card is open. */
export function useBotRowDetails(bot: Bot, home: FolderWorkspace) {
  const workspaceId = folderWorkspaceKey(home.id)
  const status = foldBotStatus(useWorktreeActivityStatus(workspaceId), bot.paused)
  const hostLabel = useBotHostLabel(bot.hostId)
  const offline = useBotHostOffline(bot.hostId)
  const description = useBotSoulDescription({ bot, folderPath: home.folderPath })
  const { line, limit, now } = useBotRowLine(bot, home)
  return { workspaceId, status, hostLabel, offline, description, line, limit, now }
}

export function BotHoverDetails({
  bot,
  details,
  onOpenHome
}: {
  bot: Bot
  details: ReturnType<typeof useBotRowDetails>
  onOpenHome: () => void
}): React.JSX.Element {
  const { workspaceId, status, hostLabel, offline, description, line, now } = details
  const t = useTranslate()
  const current = useWorktreeAgentRows(workspaceId).find((row) => row.state === 'working')
  const action = current
    ? formatAgentToolPreview(current.entry, current.state) || getAgentRowPrimaryText(current.entry)
    : ''
  const liveStatus = status === 'permission' ? status : action ? 'working' : status
  const homeLabel = t('bots.hover.openHome', 'Open {{name}}’s Home', { name: bot.name })
  const state = offline
    ? t('bots.row.disconnected', 'Disconnected')
    : bot.paused
      ? t('bots.row.paused', 'Paused')
      : liveStatus === 'active'
        ? t('bots.row.idle', 'Idle')
        : (liveStatus === 'working' && action) || getWorktreeStatusLabel(liveStatus)
  const StatusIcon = offline ? Unplug : bot.paused ? Pause : liveStatus === 'active' ? Circle : null
  return (
    <div className="flex flex-col">
      <div className="flex items-start gap-2.5">
        <BotAvatar bot={bot} className="size-10 rounded-lg text-sm" />
        <div className="flex min-w-0 flex-1 flex-col gap-1 self-center">
          <div className="flex min-w-0 items-center gap-1.5">
            <BotHoverHostIcon hostId={bot.hostId} hostLabel={hostLabel} />
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="min-w-0 truncate text-[13px] leading-4 font-semibold text-foreground">
                  {bot.name}
                </div>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-72 whitespace-pre-line">
                {description ? `${bot.name}\n${description}` : bot.name}
              </TooltipContent>
            </Tooltip>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground">
                {StatusIcon ? (
                  <span className="flex size-3 shrink-0 items-center justify-center" aria-hidden>
                    <StatusIcon className={StatusIcon === Circle ? 'size-2' : 'size-3'} />
                  </span>
                ) : (
                  <StatusIndicator status={liveStatus} showTooltip={false} aria-hidden />
                )}
                <span className="min-w-0 truncate">{state}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-80 break-words">
              {state}
            </TooltipContent>
          </Tooltip>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="-mt-0.5 -mr-1 shrink-0"
              aria-label={homeLabel}
              onClick={(event) => {
                event.stopPropagation()
                onOpenHome()
              }}
            >
              <House className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{homeLabel}</TooltipContent>
        </Tooltip>
      </div>
      {/* Needs you names its asks below, so the bare count line would repeat it. */}
      {line?.kind === 'needYouElsewhere' ? null : <BotHoverLatestLine line={line} now={now} />}
      {offline || bot.paused ? null : <BotHoverNeedsYou bot={bot} onReview={onOpenHome} />}
    </div>
  )
}

function BotHoverHostIcon({
  hostId,
  hostLabel
}: {
  hostId: ExecutionHostId
  hostLabel: string | null
}): React.JSX.Element {
  const t = useTranslate()
  // A paired browser's local runtime is the server running Orca.
  const paired = hostId === LOCAL_EXECUTION_HOST_ID && isPairedWebClientWindow()
  const Icon = hostId === LOCAL_EXECUTION_HOST_ID && !paired ? Laptop : Server
  const label = useAppStore((state) => {
    if (hostLabel) {
      return hostLabel
    }
    if (paired) {
      const environment = state.runtimeEnvironments?.[0]
      return environment && state.runtimeEnvironments?.length === 1
        ? selectExecutionHostDisplayLabel(state, toRuntimeExecutionHostId(environment.id), { t })
        : t('bots.items.comment.thisServer', 'This server')
    }
    return selectExecutionHostDisplayLabel(state, hostId, { t })
  })
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={t('bots.row.runsOn', 'Runs on {{host}}', { host: label })}
          className="flex shrink-0 items-center text-muted-foreground"
        >
          <Icon className="size-3" aria-hidden />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72 break-words">
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
