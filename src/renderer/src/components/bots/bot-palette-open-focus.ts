import { useAppStore } from '@/store'
import { readHostBots } from '@/lib/bot-catalog-snapshot'
import { readBotGroups } from '@/lib/bot-group-catalog-snapshot'
import type { Bot } from '../../../../shared/bot-types'
import { requestNativeChatComposerFocus } from '@/components/native-chat/composer/focus/native-chat-composer-focus-intent'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'

// Cmd+K asks the opened destination's composer for focus outright; the sidebar reveal waits on that focus.

/** The workspace's active tab: a home without its own chat yet shows whatever it last had open. */
export function activeTabOf(workspaceId: string): string | null {
  return useAppStore.getState().activeTabIdByWorktree[workspaceId] ?? null
}

/** The group's room tab, as its open just showed or added it. */
export function roomTabOf(group: Pick<BotGroup, 'id' | 'folderWorkspaceId'>): string | null {
  const tabs =
    useAppStore.getState().unifiedTabsByWorktree[folderWorkspaceKey(group.folderWorkspaceId)]
  return tabs?.find((tab) => tab.contentType === 'room' && tab.entityId === group.id)?.id ?? null
}

/** A tab with no chat composer ignores the request; one that mounts later takes it when it does. */
export function requestOpenedChatFocus(tabId: string | null): void {
  if (tabId) {
    requestNativeChatComposerFocus(tabId)
  }
}

/** The bot as its host lists it now, by host and id; null once it's gone. */
export function readListedBot(
  bot: Pick<Bot, 'hostId' | 'id'>
): { kind: 'bot'; paused: boolean } | null {
  const live = readHostBots(bot.hostId).find((candidate) => candidate.id === bot.id)
  return live ? { kind: 'bot', paused: live.paused } : null
}

/** The group as its host lists it now; null once it's gone. */
export function readListedGroup(
  group: Pick<BotGroup, 'hostId' | 'id'>
): { kind: 'group'; paused: false } | null {
  const live = readBotGroups().some(
    (candidate) => candidate.hostId === group.hostId && candidate.id === group.id
  )
  return live ? { kind: 'group', paused: false } : null
}
