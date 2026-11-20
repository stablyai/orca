// A bot's page is its home folder workspace; these find the bot behind a workspace or a tab.
import { readBots, readBotsEnabled, useBots, useBotsEnabled } from '@/lib/bot-catalog'
import { useBotGroups } from '@/lib/bot-group-list'
import type { Bot } from '../../../../shared/bot-types'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { parseWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { botOfHomeWorkspace } from '../../../../shared/bots/bot-homes'
import { isBotHomeTab } from '../../../../shared/bots/bot-home-tab'

export function findBotByWorkspace(bots: readonly Bot[], workspaceId: string | null): Bot | null {
  return botOfHomeWorkspace(bots, workspaceId)
}

/** With bots off a home is a plain folder. */
export function isBotPage(workspaceId: string): boolean {
  return readBotsEnabled() && findBotByWorkspace(readBots(), workspaceId) !== null
}

/** Only folder workspaces can be a bot's home, so other workspaces never read the bots; with bots off a home is a plain folder. */
export function useBotForWorkspace(workspaceId: string | null): Bot | null {
  const botsEnabled = useBotsEnabled()
  const bots = useBots(botsEnabled && parseWorkspaceKey(workspaceId ?? '')?.type === 'folder')
  return findBotByWorkspace(bots, workspaceId)
}

/** The group whose room lives in this folder workspace; like a bot's home, only with bots on. */
export function useBotGroupForWorkspace(workspaceId: string | null): BotGroup | null {
  const botsEnabled = useBotsEnabled()
  const groups = useBotGroups(
    botsEnabled && parseWorkspaceKey(workspaceId ?? '')?.type === 'folder'
  )
  return botOfHomeWorkspace(groups, workspaceId)
}

/** The bot's Chat, shown as its Home tab, which stays open for the life of the bot. */
export function isBotChatSession(bots: readonly Bot[], sessionId: string): boolean {
  return bots.some((bot) => bot.chatSessionId === sessionId)
}

/** Whether `tab` is the Home of the bot whose page holds it; with bots off there is no Home. */
export function isBotChatTab(tab: Pick<Tab, 'contentType' | 'entityId' | 'worktreeId'>): boolean {
  return readBotsEnabled() && isBotHomeTab(tab, findBotByWorkspace(readBots(), tab.worktreeId))
}
