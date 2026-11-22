import { House, Server } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import StatusIndicator from '@/components/sidebar/workspace-card/surface/StatusIndicator'
import { useWorktreeActivityStatus } from '@/components/sidebar/workspace-card/activity/use-worktree-activity-status'
import { useWorktreeAgentRows } from '@/components/sidebar/workspace-card/activity/useWorktreeAgentRows'
import { useTranslate } from '@/i18n/use-translate'
import { useBotHostOffline } from '@/lib/bot-host-views'
import { getWorktreeStatusLabel } from '@/lib/workspace/activity/worktree-status'
import { formatAgentToolPreview } from '../../../../shared/agent-status/presentation/agent-row-tool-preview'
import { getAgentRowPrimaryText } from '../../../../shared/agent-status/presentation/agent-row-primary-text'
import { foldBotStatus } from '../../../../shared/bots/bot-row-status'
import type { Bot } from '../../../../shared/bot-types'
import { getLocalExecutionHostLabel } from '../../../../shared/execution-host/execution-host'
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
  const working = !offline && !bot.paused && action !== ''
  const homeLabel = t('bots.hover.openHome', 'Open {{name}}’s Home', { name: bot.name })
  const state = offline
    ? t('bots.row.hostDisconnected', '{{host}} disconnected', {
        host: hostLabel ?? getLocalExecutionHostLabel()
      })
    : bot.paused
      ? t('bots.row.paused', 'Paused')
      : action ||
        (status === 'active' ? t('bots.row.idle', 'Idle') : getWorktreeStatusLabel(status))
  return (
    <div className="flex flex-col">
      <div className="flex items-start gap-3">
        <BotAvatar bot={bot} className="size-14 rounded-lg text-xl" />
        <div className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="truncate text-[13px] font-semibold leading-snug text-foreground">
                {bot.name}
              </div>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-72 whitespace-pre-line">
              {description ? `${bot.name}\n${description}` : bot.name}
            </TooltipContent>
          </Tooltip>
          {/* One line whatever the agent is running; a command reads as work by the spinner before it,
              and the tooltip has it whole. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                {working ? <StatusIndicator status="working" showTooltip={false} /> : null}
                <span className="min-w-0 truncate">{state}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-80 break-words">
              {state}
            </TooltipContent>
          </Tooltip>
          {/* A paired server's bot says where it runs; a disconnected one already named it. */}
          {hostLabel && !offline ? (
            <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              <Server className="size-3 shrink-0" aria-hidden="true" />
              <span className="truncate">
                {t('bots.row.runsOn', 'Runs on {{host}}', { host: hostLabel })}
              </span>
            </div>
          ) : null}
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
