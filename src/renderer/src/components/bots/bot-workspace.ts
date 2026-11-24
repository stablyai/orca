// A bot's page is its home folder workspace; these find the bot behind a workspace or a tab.
import { readBots, readBotsEnabled, useBots, useBotsEnabled } from '@/lib/bot-catalog'
import { useBotGroups } from '@/lib/bot-group-list'
import type { Bot } from '../../../../shared/bot-types'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import {
  folderWorkspaceKey,
  parseWorkspaceKey
} from '../../../../shared/workspace/identity/workspace-scope'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { botOfHomeWorkspace } from '../../../../shared/bots/bot-homes'
import { isBotHomeTab } from '../../../../shared/bots/bot-home-tab'

// The catalog is a snapshot replaced on change; every row naming a sender looks its bot up again
// on each redraw, so each snapshot is indexed once rather than searched per lookup.
const homeIndexes = new WeakMap<readonly Bot[], Map<string, Bot>>()

function homeIndex(bots: readonly Bot[]): Map<string, Bot> {
  let index = homeIndexes.get(bots)
  if (!index) {
    index = new Map()
    for (const bot of bots) {
      const home = folderWorkspaceKey(bot.folderWorkspaceId)
      // First wins, as a search from the start would: unqualified, and qualified by host.
      if (!index.has(home)) {
        index.set(home, bot)
      }
      const onHost = `${bot.hostId}\0${home}`
      if (!index.has(onHost)) {
        index.set(onHost, bot)
      }
    }
    homeIndexes.set(bots, index)
  }
  return index
}

/** With `hostId`, only a bot on that host, so the same workspace id on two hosts never names the other's bot. */
export function findBotByWorkspace(
  bots: readonly Bot[],
  workspaceId: string | null,
  hostId?: ExecutionHostId
): Bot | null {
  if (!workspaceId || bots.length === 0) {
    return null
  }
  return homeIndex(bots).get(hostId ? `${hostId}\0${workspaceId}` : workspaceId) ?? null
}

/** With bots off a home is a plain folder. */
export function isBotPage(workspaceId: string): boolean {
  return readBotsEnabled() && findBotByWorkspace(readBots(), workspaceId) !== null
}

/** Only folder workspaces can be a bot's home, so other workspaces never read the bots; with bots off a home is a plain folder. */
export function useBotForWorkspace(
  workspaceId: string | null,
  hostId?: ExecutionHostId
): Bot | null {
  const botsEnabled = useBotsEnabled()
  const bots = useBots(botsEnabled && parseWorkspaceKey(workspaceId ?? '')?.type === 'folder')
  return findBotByWorkspace(bots, workspaceId, hostId)
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
