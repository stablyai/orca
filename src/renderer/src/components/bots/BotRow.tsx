import React, { useEffect, useId } from 'react'
import { openBotSettings } from './bot-settings-open'
import { ChevronDown, Copy, Monitor, Pause, Play, Server, Settings, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu'
import StatusIndicator from '@/components/sidebar/workspace-card/surface/StatusIndicator'
import { useTranslate } from '@/i18n/use-translate'
import { openBotHome, updateBot } from '@/lib/bot-catalog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useBotUpNextUnseen } from '@/lib/bot-up-next-unseen'
import { cn } from '@/lib/class-names'
import { getWorktreeStatusLabel } from '@/lib/workspace/activity/worktree-status'
import type { Bot } from '../../../../shared/bot-types'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import { botErrorMessage } from './bot-presentation'
import {
  botFoldLiveStatus,
  type BotWorkspaceLiveCounts
} from '../../../../shared/bots/bot-sidebar-workspaces'
import { BotAvatar } from './BotAvatar'
import { FOLD_TOGGLE_CLASS } from './BotChatRowControls'
import { botRowLineAge, BotRowLineView } from './BotRowActivityLine'
import { BotSidebarRow } from './BotSidebarRow'
import { revealBotHome } from './BotHoverNeedsYou'
import { BotHoverDetails, useBotRowDetails } from './BotHoverDetails'
import { usageLimitStopTip } from './BotUsageLimitMark'
import { BotUpNextCount } from './BotUpNextCount'
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
  onChooseComputer?: () => void
}

export function BotRow({
  bot,
  home,
  isActive,
  onOpen,
  fold = null,
  dragHandle = false,
  onChooseComputer
}: BotRowProps): React.JSX.Element {
  const t = useTranslate()
  const details = useBotRowDetails(bot, home)
  const { workspaceId, status, hostLabel, offline, description, line, limit, now } = details
  const isUnread = home.isUnread && !offline
  const upNextNew = useBotUpNextUnseen(bot)
  const age = offline ? null : botRowLineAge(line, now)
  const hostPill = hostLabel ? <BotRowHostIcon label={hostLabel} /> : null
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
      avatar={<BotAvatar bot={bot} className="size-8 rounded-md text-sm" />}
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
      trailing={
        fold ? (
          <BotRowFoldToggle
            botName={bot.name}
            fold={fold}
            working={!offline && status === 'working'}
          />
        ) : null
      }
      hoverDetails={() => (
        <BotHoverDetails
          bot={bot}
          details={details}
          onOpenHome={() => openBotHomePanelFromSidebar(bot, onOpen)}
        />
      )}
      menuItems={
        <>
          <ContextMenuItem onSelect={() => openBotSettings(bot.id)}>
            <Settings className="size-3.5" />
            {t('bots.row.settings', 'Bot settings…')}
          </ContextMenuItem>
          {onChooseComputer ? (
            <ContextMenuItem onSelect={onChooseComputer}>
              <Monitor className="size-3.5" />
              {t('bots.computerView.choose', 'Show under computer…')}
            </ContextMenuItem>
          ) : null}
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

export function openBotHomePanelFromSidebar(bot: Bot, onOpened: () => void): void {
  if (openBotFromSidebar(bot, onOpened)) {
    revealBotHome()
  }
}

/** A paired server's bot: a glyph on its second line, the server's name in its tooltip, so the
 *  line keeps its width for what the bot is doing. */
function BotRowHostIcon({ label }: { label: string }): React.JSX.Element {
  const t = useTranslate()
  const tip = t('bots.row.runsOn', 'Runs on {{host}}', { host: label })
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span role="img" aria-label={tip} className="flex shrink-0 items-center">
          <Server className="size-3" aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tip}</TooltipContent>
    </Tooltip>
  )
}

function BotRowFoldToggle({
  botName,
  fold,
  working
}: {
  botName: string
  fold: BotRowFold
  /** The bot itself is working: the row's working mark sits here, on the strip. */
  working: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const statusId = useId()
  const { folded, counts } = fold
  const live = folded ? botFoldLiveStatus(counts) : null
  // One mark: a folded workspace's ask outranks the bot's own work, which outranks the rest.
  const mark = live === 'permission' ? live : working ? 'working' : live
  const label = folded
    ? t('bots.chats.unfold', 'Unfold {{name}}', { name: botName })
    : t('bots.chats.fold', 'Fold {{name}}', { name: botName })
  return (
    // The row's whole right edge, top to bottom, so it is easy to hit; a folded summary widens it
    // leftward.
    <button
      type="button"
      className={cn(
        FOLD_TOGGLE_CLASS,
        // Negative margins cancel the row's padding so the strip spans its full height and right
        // edge; the row's rounded overflow clips its corners.
        '-mt-1.25 -mr-1.5 -mb-1.25 min-w-10 gap-0.5 self-stretch rounded-none px-1.5 text-xs tabular-nums',
        'focus-visible:ring-2 focus-visible:ring-inset',
        // A narrow row keeps more width for the name and time where a pointer can hover: a compact
        // strip, still a 24px target, whose size never changes, so hover and focus never move the
        // row's text. Touch keeps the full strip.
        'can-hover:pointer-fine:@max-[15rem]/bot-row:min-w-6 can-hover:pointer-fine:@max-[15rem]/bot-row:px-1'
      )}
      aria-label={label}
      aria-describedby={mark === 'working' ? statusId : undefined}
      aria-expanded={!folded}
      onClick={(event) => {
        event.stopPropagation()
        fold.onToggle()
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {/* Folded, only its most urgent live workspace's status: a bare count of every workspace it
          ever made said nothing at a glance. Folded or not, the bot's own work shows here too. */}
      {mark === 'working' ? (
        <span id={statusId} className="sr-only">
          {getWorktreeStatusLabel(mark)}
        </span>
      ) : null}
      {mark ? (
        <span className="flex items-center">
          <StatusIndicator status={mark} showTooltip={false} />
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
