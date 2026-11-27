import React from 'react'
import {
  Bell,
  BellMinus,
  BellOff,
  BellRing,
  Copy,
  Pause,
  Pencil,
  Play,
  Settings,
  Trash2
} from 'lucide-react'
import { toast } from 'sonner'
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator
} from '@/components/ui/context-menu'
import { useTranslate } from '@/i18n/use-translate'
import { updateBot } from '@/lib/bot-catalog'
import { useBotHostOffline } from '@/lib/bot-host-views'
import { useAppStore } from '@/store'
import type { Bot } from '../../../../shared/bot-types'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { botErrorMessage } from './bot-presentation'
import { openBotSettings } from './bot-settings-open'
import { useDeleteBot } from './use-delete-bot'

export function BotSidebarRowMenuContent({
  workspaceId,
  hostId,
  isUnread,
  actionsDisabled = false,
  onRename,
  menuItems,
  menuFooter
}: {
  workspaceId: string
  hostId: ExecutionHostId
  isUnread: boolean
  actionsDisabled?: boolean
  onRename: () => void
  menuItems: React.ReactNode
  menuFooter: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const setWorkspaceUnreadByUser = useAppStore((s) => s.setWorkspaceUnreadByUser)
  const toggleUnread = (): void => setWorkspaceUnreadByUser(workspaceId, !isUnread, hostId)
  return (
    <ContextMenuContent className="w-52">
      <ContextMenuItem disabled={actionsDisabled} onSelect={onRename}>
        <Pencil className="size-3.5" />
        {t('bots.row.rename', 'Rename')}
      </ContextMenuItem>
      {menuItems}
      <ContextMenuItem disabled={actionsDisabled} onSelect={toggleUnread}>
        {isUnread ? <BellOff className="size-3.5" /> : <Bell className="size-3.5" />}
        {isUnread ? t('bots.row.markRead', 'Mark Read') : t('bots.row.markUnread', 'Mark Unread')}
      </ContextMenuItem>
      <BotNotificationMuteMenuItem workspaceId={workspaceId} />
      {menuFooter}
    </ContextMenuContent>
  )
}

export function BotRowMenuItems({
  bot,
  home,
  offline
}: {
  bot: Bot
  home: FolderWorkspace
  offline: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const run = (work: Promise<unknown>): void => {
    work.catch((error: unknown) => toast.error(botErrorMessage(error)))
  }
  return (
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
  )
}

export function BotRowMenuFooter({
  bot,
  offline
}: {
  bot: Bot
  offline: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const handleDelete = useDeleteBot(bot)
  return (
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
  )
}

/** The bot row's full context menu, shared by the expanded list and the folded avatar strip. */
export function BotRowContextMenuContent({
  bot,
  home,
  onRename
}: {
  bot: Bot
  home: FolderWorkspace
  onRename: () => void
}): React.JSX.Element {
  const offline = useBotHostOffline(bot.hostId)
  const workspaceId = folderWorkspaceKey(home.id)
  const isUnread = home.isUnread && !offline
  return (
    <BotSidebarRowMenuContent
      workspaceId={workspaceId}
      hostId={bot.hostId}
      isUnread={isUnread}
      actionsDisabled={offline}
      onRename={onRename}
      menuItems={<BotRowMenuItems bot={bot} home={home} offline={offline} />}
      menuFooter={<BotRowMenuFooter bot={bot} offline={offline} />}
    />
  )
}

/** Mounted only while the context menu is open, so closed rows never subscribe to the mute map. */
function BotNotificationMuteMenuItem({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const t = useTranslate()
  const notificationsMuted = useAppStore(
    (s) => s.notificationsMutedByWorktree?.[workspaceId] === true
  )
  const toggleWorktreeNotificationsMuted = useAppStore((s) => s.toggleWorktreeNotificationsMuted)
  return (
    <ContextMenuItem onSelect={() => toggleWorktreeNotificationsMuted(workspaceId)}>
      {notificationsMuted ? <BellRing className="size-3.5" /> : <BellMinus className="size-3.5" />}
      {notificationsMuted
        ? t(
            'auto.components.sidebar.WorktreeContextMenu.unmuteNotifications',
            'Unmute Notifications'
          )
        : t('auto.components.sidebar.WorktreeContextMenu.muteNotifications', 'Mute Notifications')}
    </ContextMenuItem>
  )
}
