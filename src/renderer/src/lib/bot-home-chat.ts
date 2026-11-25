import type { Bot } from '../../../shared/bot-types'
import { activateAndRevealFolderWorkspace } from './workspace/activation/worktree-activation'
import {
  activateStructuredAgentSessionById,
  activateStructuredAgentSessionTabOnOwner
} from './agent-session/structured-agent-session-tab-activation'
import { folderWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'
import { structuredAgentSessionTabId } from '../../../shared/agent-session/view/structured-agent-session-projection'
import { appendNativeChatDraftCache } from '@/components/native-chat/drafts/native-chat-draft-views'
import { readHostBots } from './bot-catalog-snapshot'
import { refreshBotHost } from './bot-host-refresh'
import { botTarget, callBotRpc, type BotRef } from './bot-hosts'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import { useAppStore } from '@/store'
import { requestNativeChatComposerFocus } from '../components/native-chat/composer/focus/native-chat-composer-focus-intent'
import { structuredAgentSessionDraftScopeKey } from '../components/native-chat/drafts/native-chat-draft-scope'

/** Keeps the bot's Chat, its Home tab, or creates one if it has none that still fits. */
export async function openBotChat(
  bot: BotRef,
  canContinue: () => boolean = () => true
): Promise<string> {
  if (!canContinue()) {
    throw new Error('Bot owner changed')
  }
  const { sessionId } = await callBotRpc<{ sessionId: string }>(bot, 'bots.chat.open', {
    botId: bot.id
  })
  if (!canContinue()) {
    throw new Error('Bot owner changed')
  }
  await refreshBotHost(bot.hostId)
  if (!canContinue()) {
    throw new Error('Bot owner changed')
  }
  return sessionId
}

/** False when the home is not in the catalog (or not reachable) yet. */
export function openBotHome(bot: Bot): boolean {
  const opened = activateAndRevealFolderWorkspace(bot.folderWorkspaceId, {
    executionHostId: bot.hostId,
    // Bots are not rows of the workspace list, so there is nothing there to reveal.
    revealInSidebar: false
  })
  return opened !== false
}

/**
 * The bot's page on its Home tab, whatever tab was last open there. False when its home can't open yet.
 * `draft` is added to Home's unsent message, never sent, and its composer takes focus.
 */
export async function openBotHomeTab(
  bot: Bot,
  options?: { draft?: string; canContinue?: () => boolean }
): Promise<boolean> {
  const canContinue = options?.canContinue ?? (() => true)
  if (!canContinue()) {
    return false
  }
  // Home exists before the page opens, so the page lands on it rather than on a new terminal.
  const chatSessionId = await openBotChat(bot, canContinue).catch((error: unknown) => {
    console.error('Failed to open the bot chat:', error)
    return null
  })
  if (!canContinue()) {
    return false
  }
  // The home must be in the catalog before it can open.
  await useAppStore
    .getState()
    .fetchFolderWorkspaces({ runtimeEnvironmentId: runtimeTargetEnvironmentId(botTarget(bot)) })
  if (!canContinue() || !openBotHome(bot)) {
    return false
  }
  if (chatSessionId) {
    const worktreeId = folderWorkspaceKey(bot.folderWorkspaceId)
    // An open Home switches here; one not in this window yet opens when the host's activation arrives.
    if (!activateStructuredAgentSessionById({ worktreeId, sessionId: chatSessionId })) {
      activateStructuredAgentSessionTabOnOwner(worktreeId, chatSessionId)
    }
    if (options?.draft) {
      appendNativeChatDraftCache(structuredAgentSessionDraftScopeKey(chatSessionId), options.draft)
      // The draft lands once, here: the cache reaches a mounted composer and seeds one that mounts
      // later. The focus request after the activation only puts the caret after it, adding nothing.
      requestNativeChatComposerFocus(structuredAgentSessionTabId(chatSessionId), {
        revealDraft: true
      })
    }
  }
  return !options?.draft || chatSessionId !== null
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
