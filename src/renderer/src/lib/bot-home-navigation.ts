import type { Bot } from '../../../shared/bot-types'
import { useAppStore } from '@/store'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import { botTarget, callBotRpc, type BotRef } from './bot-hosts'
import { readHostBots } from './bot-catalog-snapshot'
import { refreshBotHost } from './bot-host-refresh'
import { activateAndRevealFolderWorkspace } from './workspace/activation/worktree-activation'
import {
  activateStructuredAgentSessionById,
  activateStructuredAgentSessionTabOnOwner
} from './agent-session/structured-agent-session-tab-activation'
import { folderWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'
import { structuredAgentSessionTabId } from '../../../shared/agent-session/view/structured-agent-session-projection'
import { appendNativeChatDraftCache } from '@/components/native-chat/drafts/native-chat-draft-views'
import { requestNativeChatComposerFocus } from '../components/native-chat/composer/focus/native-chat-composer-focus-intent'
import { structuredAgentSessionDraftScopeKey } from '../components/native-chat/drafts/native-chat-draft-scope'

/** Keeps the bot's Chat, its Home tab, or creates one if it has none that still fits. */
export async function openBotChat(bot: BotRef): Promise<string> {
  const { sessionId } = await callBotRpc<{ sessionId: string }>(bot, 'bots.chat.open', {
    botId: bot.id
  })
  await refreshBotHost(bot.hostId)
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
  options?: {
    draft?: string
    destination?: 'composer'
    isCurrent?: () => boolean
    prepareDraft?: (sessionId: string) => () => void
  }
): Promise<boolean> {
  // Home exists before the page opens, so the page lands on it rather than on a new terminal.
  const chatSessionId = await openBotChat(bot).catch((error: unknown) => {
    if (options?.destination === 'composer') {
      throw error
    }
    console.error('Failed to open the bot chat:', error)
    return null
  })
  if (options?.isCurrent?.() === false) {
    return false
  }
  // The home must be in the catalog before it can open.
  await useAppStore
    .getState()
    .fetchFolderWorkspaces({ runtimeEnvironmentId: runtimeTargetEnvironmentId(botTarget(bot)) })
  if (options?.isCurrent?.() === false || (!chatSessionId && options?.destination === 'composer')) {
    return false
  }
  if (options?.prepareDraft) {
    const currentHome = readHostBots(bot.hostId).find(
      (listed) => listed.id === bot.id
    )?.chatSessionId
    if (currentHome && currentHome !== chatSessionId) {
      return false
    }
  }
  const insertDraft = chatSessionId ? options?.prepareDraft?.(chatSessionId) : undefined
  if (!openBotHome(bot) || options?.isCurrent?.() === false) {
    return false
  }
  if (chatSessionId) {
    const worktreeId = folderWorkspaceKey(bot.folderWorkspaceId)
    // An open Home switches here; one not in this window yet opens when the host's activation arrives.
    if (
      !activateStructuredAgentSessionById({
        worktreeId,
        sessionId: chatSessionId,
        target: botTarget(bot)
      })
    ) {
      activateStructuredAgentSessionTabOnOwner(worktreeId, chatSessionId, botTarget(bot))
    }
    if (options?.isCurrent?.() === false) {
      return false
    }
    insertDraft?.()
    if (options?.draft) {
      appendNativeChatDraftCache(structuredAgentSessionDraftScopeKey(chatSessionId), options.draft)
    }
    if (options?.draft || options?.destination === 'composer') {
      // The draft lands once, here: the cache reaches a mounted composer and seeds one that mounts
      // later. The focus request after the activation only puts the caret after it, adding nothing.
      requestNativeChatComposerFocus(structuredAgentSessionTabId(chatSessionId), {
        revealDraft: true
      })
    }
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
