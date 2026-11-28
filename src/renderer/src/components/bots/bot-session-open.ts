import { activateAiVaultStructuredSession } from '@/lib/agent-session/open/activate-ai-vault-structured-session'
import { cancelPendingBotThreadOpen } from '@/lib/agent-session/open/bot-thread-open-lifecycle'
import { targetBotChatLatest } from '@/lib/agent-session/open/bot-link-item-target'
import { botTarget, callBotRpc, type BotOnHost, type BotRef } from '@/lib/bot-hosts'
import { activateAndRevealFolderWorkspaceWithOutcome } from '@/lib/workspace/activation/worktree-activation'
import { showChatOpenUnavailable } from '@/lib/agent-session/open/chat-open-failure-toast'
import { translate } from '@/i18n/i18n'
import { watchBotOpenIntent, type BotOpenIntent } from './bot-open-intent'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { selectFocusedChatTab } from '@/lib/focused-chat-workers'
import { useAppStore } from '@/store'
import { requestNativeChatComposerFocus } from '@/components/native-chat/composer/focus/native-chat-composer-focus-intent'
import type { Bot } from '../../../../shared/bot-types'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'

/** A bot's home as the catalog stamps it: on the host that listed the bot, not only this computer. */
type BotHome = Pick<Bot, 'folderWorkspaceId'> & BotOnHost

/** Why the open stopped, as the toast's one body line: the Home lives on the bot's host. */
function homeDidNotLoad(): string {
  return translate('bots.chatOpen.homeDidNotLoad', "Bot's Home didn't load.")
}

function admitHome(bot: BotHome): ReturnType<typeof activateAndRevealFolderWorkspaceWithOutcome> {
  return activateAndRevealFolderWorkspaceWithOutcome(bot.folderWorkspaceId, {
    executionHostId: bot.hostId,
    // Bots are not rows of the workspace list, so there is nothing there to reveal.
    revealInSidebar: false
  })
}

/** A server bot's chat tabs reach this window only through its home's workspace stream, so the
 *  home opens here first, as a Slack link's does. This computer's bots publish their tabs directly.
 *  `notified`: the refusal already told the user why (a blocked folder path). `stale`: the user
 *  moved to another workspace since asking, so the window stays where they put it. */
async function admitServerBotHome(
  bot: BotHome,
  intent: BotOpenIntent
): Promise<'opened' | 'refused' | 'notified' | 'stale'> {
  if (intent.moved()) {
    return 'stale'
  }
  if (bot.hostId === LOCAL_EXECUTION_HOST_ID) {
    return 'opened'
  }
  let outcome = admitHome(bot)
  if ('refused' in outcome && outcome.refused.reason === 'workspace-missing') {
    // The home must be in the catalog before it can open; a failed read leaves it refused.
    try {
      await useAppStore
        .getState()
        .fetchFolderWorkspaces({ runtimeEnvironmentId: runtimeTargetEnvironmentId(botTarget(bot)) })
    } catch {
      /* Reported below as a home that did not open, with Retry. */
    }
    if (intent.moved()) {
      return 'stale'
    }
    outcome = admitHome(bot)
  }
  return 'opened' in outcome ? 'opened' : outcome.refused.failureNotified ? 'notified' : 'refused'
}

/** The user's click on a bot chat. A pending thread link yields to it now, as to any newer
 *  navigation, not once the Home step below has finished. */
function clickBotOpen(): BotOpenIntent {
  cancelPendingBotThreadOpen()
  return watchBotOpenIntent()
}

/**
 * Opens one of the bot's chats as a focused tab, on the host that runs the bot. `intent` starts at the
 * user's click (a new chat's starts before the host made it); absent, the click is now. Retry is a
 * new click that repeats both steps for this same chat, so a home that failed to load gets another
 * try and nothing starts anew.
 */
export async function openBotChatTab(
  bot: BotHome,
  sessionId: string,
  intent: BotOpenIntent = clickBotOpen()
): Promise<boolean> {
  const retry = (): Promise<boolean> => openBotChatTab(bot, sessionId)
  // The home switch below is this open's own move; nothing past it is watched.
  const home = await admitServerBotHome(bot, intent).finally(intent.stop)
  if (home !== 'opened') {
    if (home === 'refused') {
      showChatOpenUnavailable({
        message: homeDidNotLoad(),
        retry: () => void retry().catch(() => {})
      })
    }
    return false
  }
  // A thread link opened since the click is newer; this open would cancel it, so it yields.
  if (intent.linkOpened()) {
    return false
  }
  return activateAiVaultStructuredSession(
    { structuredSession: { sessionId, workspaceId: folderWorkspaceKey(bot.folderWorkspaceId) } },
    { retry },
    botTarget(bot)
  )
}

/** Starts a bot chat on its host from the user's click, then opens it here. A move to another
 *  workspace while the host starts it keeps the window where the user put it. */
export function startAndOpenBotChat(
  bot: BotHome,
  start: () => Promise<string>,
  onError: (error: unknown) => void
): void {
  const intent = clickBotOpen()
  void start()
    .then((sessionId) => openBotChatTab(bot, sessionId, intent))
    .catch(onError)
    .finally(intent.stop)
}

/** Opening a chat without a tab reveals it, which marks its thread seen; activating its open tab here
 *  doesn't, so this says so. An older host has no such method and keeps the thread new. */
async function markSeen(bot: BotRef, sessionIds: string[]): Promise<void> {
  if (sessionIds.length > 0) {
    await callBotRpc(bot, 'bots.chats.seen', { sessionIds }).catch(() => undefined)
  }
}

/** The chat's tab when it is the one on screen, where activating it again would change nothing. */
function shownChatTab(bot: BotHome, sessionId: string): { id: string } | null {
  const state = useAppStore.getState()
  const workspaceId = folderWorkspaceKey(bot.folderWorkspaceId)
  if (state.activeView !== 'terminal' || state.activeWorktreeId !== workspaceId) {
    return null
  }
  const tab = selectFocusedChatTab(state, workspaceId)
  return tab?.entityId === sessionId ? tab : null
}

/** Opens one of the bot's chats as a focused tab; a thread's or a run's gets its tab here. The chat
 *  already on screen goes to its newest output, its composer focused with the usual glow. */
export function openBotSession(bot: BotHome & BotRef, sessionId: string): void {
  const shown = shownChatTab(bot, sessionId)
  if (shown) {
    cancelPendingBotThreadOpen()
    targetBotChatLatest(sessionId)
    requestNativeChatComposerFocus(shown.id, { revealDraft: true })
    return
  }
  void openBotChatTab(bot, sessionId).then((opened) =>
    opened ? markSeen(bot, [sessionId]) : undefined
  )
}
