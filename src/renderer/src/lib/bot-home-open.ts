// What opening an agent shows: its home, on its chat. A bot of this account's own hosts opens on its
// Home Chat; an agent shared with this account (whose Home Chat is its owner's) on this account's
// newest chat with it, else a new one. Never a terminal in its folder.
import type { Bot } from '../../../shared/bot-types'
import { orderBotChats, type BotChatTreeRead } from '../../../shared/bots/bot-chat-tree'
import { botOfHomeWorkspace } from '../../../shared/bots/bot-homes'
import { botHomeHostId } from '../../../shared/bots/bot-home-host'
import { structuredAgentSessionTabId } from '../../../shared/agent-session/view/structured-agent-session-projection'
import { folderWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'
import { appendNativeChatDraftCache } from '@/components/native-chat/drafts/native-chat-draft-views'
import { requestNativeChatComposerFocus } from '@/components/native-chat/composer/focus/native-chat-composer-focus-intent'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/drafts/native-chat-draft-scope'
import {
  readSharedBotHosts,
  sharedBotHostOf
} from '@/runtime/hosts/shared-bot-hosts/shared-bot-host-catalog'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import { useAppStore } from '@/store'
import { activateAiVaultStructuredSession } from './agent-session/open/activate-ai-vault-structured-session'
import {
  activateStructuredAgentSessionById,
  activateStructuredAgentSessionTabOnOwner
} from './agent-session/structured-agent-session-tab-activation'
import { openBotChat, readHostBots, refreshBotHost, startBotSession } from './bot-catalog'
import { readBots } from './bot-catalog-snapshot'
import { botHostTarget, botRefKey, callBotRpc, type BotRef } from './bot-hosts'
import { activateAndRevealFolderWorkspace } from './workspace/activation/worktree-activation'

/** False when the home is not in the catalog (or not reachable) yet. A home with no tab open shows
 *  the agent's chat. */
export function openBotHome(bot: Bot): boolean {
  const opened = activateAndRevealFolderWorkspace(bot.folderWorkspaceId, {
    executionHostId: botHomeHostId(bot),
    // Bots are not rows of the workspace list, so there is nothing there to reveal.
    revealInSidebar: false,
    // Its chat is the surface, opened below when no tab is.
    providesInitialSurface: true
  })
  if (opened === false) {
    return false
  }
  const key = folderWorkspaceKey(bot.folderWorkspaceId)
  if (useAppStore.getState().reconcileWorktreeTabModel(key).renderableTabCount === 0) {
    void openBotHomeChat(bot)
  }
  return true
}

const opening = new Map<string, Promise<string | null>>()

/** Opens the chat opening `bot` shows, once at a time per bot; the session it opened, or null. */
export function openBotHomeChat(bot: Bot): Promise<string | null> {
  const key = botRefKey(bot)
  const running = opening.get(key)
  if (running) {
    return running
  }
  const open = openChat(bot)
    .catch((error: unknown) => {
      console.error('Failed to open the bot chat:', error)
      return null
    })
    .finally(() => opening.delete(key))
  opening.set(key, open)
  return open
}

async function openChat(bot: Bot): Promise<string | null> {
  const worktreeId = folderWorkspaceKey(bot.folderWorkspaceId)
  if (sharedBotHostOf(bot.hostId)) {
    const sessionId = await sharedBotOpeningSession(bot)
    return (await activateAiVaultStructuredSession({
      structuredSession: { workspaceId: worktreeId, sessionId }
    }))
      ? sessionId
      : null
  }
  const sessionId = await openBotChat(bot)
  // An open Home switches here; one not in this window yet opens when the host's activation arrives.
  if (!activateStructuredAgentSessionById({ worktreeId, sessionId })) {
    activateStructuredAgentSessionTabOnOwner(worktreeId, sessionId)
  }
  return sessionId
}

/** This account's newest chat with a shared agent still open, else a new one (held while its
 *  owner's computer is away). */
async function sharedBotOpeningSession(bot: Bot): Promise<string> {
  const tree = await callBotRpc<BotChatTreeRead>(bot, 'bots.chatTree', { botId: bot.id }).catch(
    () => null
  )
  const newest = orderBotChats((tree?.chats ?? []).filter((chat) => !chat.closed && !chat.run))[0]
  return newest
    ? (newest.liveSessionId ?? newest.chatId)
    : await startBotSession(bot, { agent: bot.agent })
}

/** Whether `worktreeId` is an agent's home, whose chat then opens in place of a seeded shell. A
 *  shared agent's home is one before its host first answers, so it never gets a shell either. */
export function openAgentHomeChatInsteadOfShell(worktreeId: string): boolean {
  const bot = botOfHomeWorkspace(readBots(), worktreeId)
  if (bot) {
    void openBotHomeChat(bot)
    return true
  }
  return readSharedBotHosts().some(
    (host) =>
      host.homeWorkspaceId !== null && folderWorkspaceKey(host.homeWorkspaceId) === worktreeId
  )
}

/**
 * The bot's page on its Home tab, whatever tab was last open there. False when its home can't open yet.
 * `draft` is added to its chat's unsent message, never sent, and its composer takes focus.
 */
export async function openBotHomeTab(bot: Bot, options?: { draft?: string }): Promise<boolean> {
  // The home must be in the catalog before it can open.
  await useAppStore.getState().fetchFolderWorkspaces({
    runtimeEnvironmentId: runtimeTargetEnvironmentId(botHostTarget(botHomeHostId(bot)))
  })
  if (!openBotHome(bot)) {
    return false
  }
  const sessionId = await openBotHomeChat(bot)
  if (sessionId && options?.draft) {
    appendNativeChatDraftCache(structuredAgentSessionDraftScopeKey(sessionId), options.draft)
    // The draft lands once, here: the cache reaches a mounted composer and seeds one that mounts
    // later. The focus request after the activation only puts the caret after it, adding nothing.
    requestNativeChatComposerFocus(structuredAgentSessionTabId(sessionId), { revealDraft: true })
  }
  return true
}

/** Reads the host's list first when nothing has loaded it yet. False for no such bot. */
export async function openBotHomeTabById(ref: BotRef): Promise<boolean> {
  const find = (): Bot | undefined => readHostBots(ref.hostId).find((bot) => bot.id === ref.id)
  if (!find()) {
    await refreshBotHost(ref.hostId)
  }
  const bot = find()
  return bot ? openBotHomeTab(bot) : false
}
