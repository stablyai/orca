import React, { useEffect } from 'react'
import { openBotSettings } from './bot-settings-open'
import { ChevronDown, Copy, Pause, Play, Settings, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu'
import StatusIndicator from '@/components/sidebar/workspace-card/surface/StatusIndicator'
import { useWorktreeActivityStatus } from '@/components/sidebar/workspace-card/activity/use-worktree-activity-status'
import { useWorktreeAgentRows } from '@/components/sidebar/workspace-card/activity/useWorktreeAgentRows'
import { useTranslate } from '@/i18n/use-translate'
import { openBotHome, updateBot } from '@/lib/bot-catalog'
import { useBotHostOffline } from '@/lib/bot-host-views'
import { WorktreeHostContextBadge } from '@/components/sidebar/workspace-card/host/WorktreeHostContextBadge'
import { useBotUpNextUnseen } from '@/lib/bot-up-next-unseen'
import { formatAgentToolPreview } from '../../../../shared/agent-status/presentation/agent-row-tool-preview'
import { getWorktreeStatusLabel } from '@/lib/workspace/activity/worktree-status'
import { cn } from '@/lib/class-names'
import type { Bot } from '../../../../shared/bot-types'
import { getLocalExecutionHostLabel } from '../../../../shared/execution-host/execution-host'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import { getAgentRowPrimaryText } from '../../../../shared/agent-status/presentation/agent-row-primary-text'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { botErrorMessage, botFolderDisplay } from './bot-presentation'
import { foldBotStatus, type BotRowStatus } from '../../../../shared/bots/bot-row-status'
import {
  botFoldLiveStatus,
  type BotWorkspaceLiveCounts
} from '../../../../shared/bots/bot-sidebar-workspaces'
import { BotAvatar } from './BotAvatar'
import { FOLD_TOGGLE_CLASS } from './BotChatRowControls'
import { useBotSoulDescription } from './bot-soul-description'
import {
  botRowLineAge,
  BotHoverLatestLine,
  BotRowLineView,
  useBotRowLine
} from './BotRowActivityLine'
import { BotSidebarRow } from './BotSidebarRow'
import { usageLimitStopTip } from './BotUsageLimitMark'
import { BotUpNextCount } from './BotUpNextCount'
import { useBotHostLabel } from './use-bot-host-label'
import { revealBotUpNext } from './bot-up-next-reveal'
import { useDeleteBot } from './use-delete-bot'
import { setBotPurpose } from './bot-purpose-cache'
import { botSidebarEntryKey } from './bot-sidebar-entry-keys'

type BotRowFold = {
  folded: boolean
  total: number
  counts: BotWorkspaceLiveCounts
  onToggle: () => void
}

type BotRowProps = {
  bot: Bot
  home: FolderWorkspace
  isActive: boolean
  onOpen: () => void
  /** The fold toggle for a bot with workspaces. */
  fold?: BotRowFold | null
  /** The Bots section's reorder: this row is where a drag starts. */
  dragHandle?: boolean
}

export function BotRow({
  bot,
  home,
  isActive,
  onOpen,
  fold = null,
  dragHandle = false
}: BotRowProps): React.JSX.Element {
  const t = useTranslate()
  const workspaceId = folderWorkspaceKey(home.id)
  // The bot's own turn only; its workspaces' work shows in the fold's count.
  const status = foldBotStatus(useWorktreeActivityStatus(workspaceId), bot.paused)
  const hostLabel = useBotHostLabel(bot.hostId)
  // Its server is down: the row stays from the last read, dimmed, with its actions off.
  const offline = useBotHostOffline(bot.hostId)
  const isUnread = home.isUnread && !offline
  const upNextNew = useBotUpNextUnseen(bot)
  const { line, limit, now } = useBotRowLine(bot, home)
  const age = offline ? null : botRowLineAge(line, now)
  const hostPill = hostLabel ? <WorktreeHostContextBadge label={hostLabel} /> : null
  // With no recent activity the line falls back to what the bot is for, so the row never shows a blank line.
  const description = useBotSoulDescription({ bot, folderPath: home.folderPath })
  // The Bots search matches purposes from what each listed row shows; it never reads SOUL.md.
  const purposeKey = botSidebarEntryKey(bot)
  useEffect(() => {
    setBotPurpose(purposeKey, description)
  }, [purposeKey, description])
  useEffect(() => () => setBotPurpose(purposeKey, null), [purposeKey])

  // Opening never unfolds; only the chevron folds. A double-click's second click renames, a held key repeats.
  const open = (event: { detail: number; repeat?: boolean }): void => {
    if (!(event.detail > 1 || event.repeat)) {
      openBotFromSidebar(bot, onOpen)
    }
  }
  const run = (work: Promise<unknown>): void => {
    work.catch((error: unknown) => toast.error(botErrorMessage(error)))
  }
  const handleDelete = useDeleteBot(bot)

  return (
    <BotSidebarRow
      avatar={<BotAvatar bot={bot} className="size-9 rounded-md text-sm" />}
      name={bot.name}
      workspaceId={workspaceId}
      hostId={bot.hostId}
      status={offline ? null : status}
      stopTip={!offline && limit ? usageLimitStopTip(t, limit.stop) : null}
      isUnread={isUnread}
      isActive={isActive}
      expanded={fold ? !fold.folded : undefined}
      dimmed={bot.paused || offline}
      actionsDisabled={offline}
      dragHandle={dragHandle}
      onOpen={open}
      onRename={async (name) => {
        try {
          await updateBot(bot, { name })
        } catch (error) {
          throw new Error(botErrorMessage(error))
        }
      }}
      age={age}
      line={
        // Time by the name, Up next count under it; both end where the fold strip starts.
        line || limit || description || fold || upNextNew > 0 || hostPill || offline ? (
          <BotRowLineView
            line={line}
            limit={offline ? null : limit}
            fallback={description}
            unread={isUnread}
            now={now}
            disconnected={offline}
            leading={hostPill}
            trailing={
              upNextNew > 0 && !offline ? (
                <BotUpNextCount
                  count={upNextNew}
                  onReveal={() => {
                    if (openBotFromSidebar(bot, onOpen)) {
                      revealBotUpNext(bot.id)
                    }
                  }}
                />
              ) : null
            }
          />
        ) : null
      }
      trailing={fold ? <BotRowFoldToggle botName={bot.name} fold={fold} /> : null}
      hoverDetails={() => (
        <BotHoverDetails
          bot={bot}
          home={home}
          workspaceId={workspaceId}
          status={status}
          hostLabel={hostLabel}
          offline={offline}
          latest={<BotHoverLatestLine line={line} now={now} />}
        />
      )}
      menuItems={
        <>
          <ContextMenuItem onSelect={() => openBotSettings(bot.id)}>
            <Settings className="size-3.5" />
            {t('bots.row.settings', 'Bot settings…')}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={offline}
            onSelect={() => run(updateBot(bot, { paused: !bot.paused }))}
          >
            {bot.paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
            {bot.paused ? t('bots.row.resume', 'Resume bot') : t('bots.row.pause', 'Pause bot')}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => window.api.ui.writeClipboardText(home.folderPath)}>
            <Copy className="size-3.5" />
            {t('bots.row.copyPath', 'Copy Path')}
          </ContextMenuItem>
        </>
      }
      menuFooter={
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            disabled={offline}
            onSelect={() => void handleDelete()}
          >
            <Trash2 className="size-3.5" />
            {t('bots.row.delete', 'Delete bot')}
          </ContextMenuItem>
        </>
      }
    />
  )
}

/** Opens the bot's home as clicking its sidebar row does; false when its home can't open yet. */
export function openBotFromSidebar(bot: Bot, onOpened: () => void): boolean {
  if (!openBotHome(bot)) {
    return false
  }
  onOpened()
  return true
}

function BotRowFoldToggle({
  botName,
  fold
}: {
  botName: string
  fold: BotRowFold
}): React.JSX.Element {
  const t = useTranslate()
  const { folded, total, counts } = fold
  const live = botFoldLiveStatus(counts)
  const label = folded
    ? t('bots.chats.unfold', 'Unfold {{name}}', { name: botName })
    : t('bots.chats.fold', 'Fold {{name}}', { name: botName })
  return (
    // The row's whole right edge, top to bottom, so it is easy to hit; a folded summary widens it
    // leftward. Its tint shows on row hover or keyboard focus, never only on hover.
    <button
      type="button"
      className={cn(
        FOLD_TOGGLE_CLASS,
        // Negative margins cancel the row's padding so the strip spans its full height and right
        // edge; the row's rounded overflow clips its corners.
        '-mt-1.25 -mr-1.5 -mb-1.25 min-w-10 gap-0.5 self-stretch rounded-none px-1.5 text-xs tabular-nums',
        // Over the toggle reads just darker than the row's own hover wash.
        'group-hover/bot-row:bg-foreground/5 hover:bg-foreground/7 focus-visible:bg-foreground/7 focus-visible:ring-2 focus-visible:ring-inset dark:hover:bg-foreground/10 dark:focus-visible:bg-foreground/10',
        // A narrow row keeps its width for the name and time where a pointer can hover: at rest the
        // strip shrinks to what it shows (nothing while unfolded), and widens on row hover or its own
        // focus. Touch keeps the full strip, since nothing would reveal it.
        'can-hover:pointer-fine:@max-[15rem]/bot-row:mr-0 can-hover:pointer-fine:@max-[15rem]/bot-row:min-w-0 can-hover:pointer-fine:@max-[15rem]/bot-row:px-0',
        'can-hover:pointer-fine:@max-[15rem]/bot-row:group-hover/bot-row:-mr-1.5 can-hover:pointer-fine:@max-[15rem]/bot-row:group-hover/bot-row:min-w-10 can-hover:pointer-fine:@max-[15rem]/bot-row:group-hover/bot-row:px-1.5',
        'can-hover:pointer-fine:@max-[15rem]/bot-row:focus-visible:-mr-1.5 can-hover:pointer-fine:@max-[15rem]/bot-row:focus-visible:min-w-10 can-hover:pointer-fine:@max-[15rem]/bot-row:focus-visible:px-1.5',
        !folded &&
          'can-hover:pointer-fine:@max-[15rem]/bot-row:-ml-1 can-hover:pointer-fine:@max-[15rem]/bot-row:w-0 can-hover:pointer-fine:@max-[15rem]/bot-row:overflow-hidden can-hover:pointer-fine:@max-[15rem]/bot-row:group-hover/bot-row:ml-0 can-hover:pointer-fine:@max-[15rem]/bot-row:group-hover/bot-row:w-auto can-hover:pointer-fine:@max-[15rem]/bot-row:focus-visible:ml-0 can-hover:pointer-fine:@max-[15rem]/bot-row:focus-visible:w-auto'
      )}
      aria-label={label}
      aria-expanded={!folded}
      onClick={(event) => {
        event.stopPropagation()
        fold.onToggle()
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {folded && (live || total > 0) ? (
        // The status of its most urgent live workspace, then how many it has in all.
        <span className="flex items-center gap-0.5">
          {live ? <StatusIndicator status={live} showTooltip={false} /> : null}
          {total > 0 ? total : null}
        </span>
      ) : null}
      <span className="flex size-4 items-center justify-center">
        <ChevronDown
          className={cn(
            'size-3.5 transition-transform',
            folded
              ? '-rotate-90'
              : "can-hover:opacity-0 group-hover/bot-row:opacity-100 [[class~='group/bot-row']:has(:focus-visible)_&]:opacity-100"
          )}
        />
      </span>
    </button>
  )
}

function BotHoverDetails({
  bot,
  home,
  workspaceId,
  status,
  hostLabel,
  offline,
  latest
}: {
  bot: Bot
  home: FolderWorkspace
  workspaceId: string
  /** The row's dot, rolled up from its workspaces. */
  status: BotRowStatus
  /** Its paired server's name; null for this computer. */
  hostLabel: string | null
  offline: boolean
  /** The row's second line, whole. */
  latest: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const current = useWorktreeAgentRows(workspaceId).find((row) => row.state === 'working')
  const description = useBotSoulDescription({ bot, folderPath: home.folderPath })
  const action = current
    ? formatAgentToolPreview(current.entry, current.state) || getAgentRowPrimaryText(current.entry)
    : ''
  return (
    <div className="flex flex-col">
      <div className="flex items-start gap-3">
        <BotAvatar bot={bot} className="size-14 rounded-lg text-xl" />
        <div className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">
          <div className="break-words text-[13px] font-semibold leading-snug text-foreground">
            {bot.name}
          </div>
          {description ? (
            <div className="line-clamp-2 text-xs text-foreground">{description}</div>
          ) : null}
          <div className="text-muted-foreground">
            {offline
              ? t('bots.row.hostDisconnected', '{{host}} disconnected', {
                  host: hostLabel ?? getLocalExecutionHostLabel()
                })
              : bot.paused
                ? t('bots.row.paused', 'Paused')
                : action ||
                  (status === 'active'
                    ? t('bots.row.idle', 'Idle')
                    : getWorktreeStatusLabel(status))}
          </div>
        </div>
      </div>
      {latest}
      <div className="mt-2.5 truncate border-t border-border pt-2 font-mono text-[11px] leading-snug text-muted-foreground">
        {hostLabel ?? getLocalExecutionHostLabel()} · {botFolderDisplay(bot.folder)}
      </div>
    </div>
  )
}
