// Ending one of a bot's side chats from the app: its row's End chat or its tab's "x". The host decides;
// this asks it once per click and says what happened in one line, or nothing when nothing is proven.
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { callBotRpc } from '@/lib/bot-hosts'
import { readBotsEnabled } from '@/lib/bot-catalog'
import { createNonSecureContextUuid } from '../../../../shared/identifiers/non-secure-context-uuid'
import { botHostHas } from '@/lib/bot-host-status'
import type { Bot } from '../../../../shared/bot-types'
import { BOTS_END_CHAT_RUNTIME_CAPABILITY } from '../../../../shared/bot-runtime-capabilities'
import {
  botChatEndReasonPermanent,
  type BotChatEndParams,
  type BotChatEndReason,
  type BotChatEndResult
} from '../../../../shared/bots/bot-chat-end'
import { openBotSession } from './bot-session-open'

/** With bots off a home is a plain folder, and its chats close as any chat does. */
export function botHostEndsChats(bot: Pick<Bot, 'hostId'>): boolean {
  return readBotsEnabled() && botHostHas(bot.hostId, BOTS_END_CHAT_RUNTIME_CAPABILITY)
}

export function requestBotChatEnd(
  bot: Bot,
  params: Omit<BotChatEndParams, 'opId' | 'botId'>
): Promise<BotChatEndResult> {
  return callBotRpc<BotChatEndResult>(bot, 'bots.endChat', {
    ...params,
    botId: bot.id,
    opId: createNonSecureContextUuid()
  })
}

export function botChatEndReasonText(reason: BotChatEndReason): string {
  switch (reason.kind) {
    case 'replying':
      return translate('bots.endChat.reason.replying', 'A reply in progress')
    case 'unread':
      return translate('bots.endChat.reason.unread', '{{count}} unread messages', {
        count: reason.count
      })
    case 'requests':
      return translate('bots.endChat.reason.requests', '{{count}} requests waiting for an answer', {
        count: reason.count
      })
    case 'questions':
      return translate('bots.endChat.reason.questions', '{{count}} questions waiting for a reply', {
        count: reason.count
      })
    case 'ran-workers':
      return translate('bots.endChat.reason.ranWorkers', 'Ran workers')
    case 'automation':
      return translate('bots.endChat.reason.automation', 'Automation "{{name}}" posts here', {
        name: reason.name
      })
    case 'automation-run':
      return translate('bots.endChat.reason.automationRun', 'Automation run still going')
    case 'usage-continue':
      return translate('bots.endChat.reason.usageContinue', 'Auto-continue after usage limit')
    case 'restart-offer':
      return translate('bots.endChat.reason.restartOffer', 'Waiting to continue after a restart')
    case 'stopping':
      return translate('bots.endChat.reason.stopping', 'Agent still stopping')
    case 'reopened':
      return translate('bots.endChat.reason.reopened', 'Reopened while ending')
    case 'unreadable':
      return translate('bots.endChat.reason.unreadable', "Couldn't check its work")
  }
}

function showEnded(bot: Bot, sessionId: string): void {
  toast.success(translate('bots.endChat.ended', 'Chat ended'), {
    action: {
      label: translate('bots.endChat.reopen', 'Reopen'),
      onClick: () => openBotSession(bot, sessionId)
    }
  })
}

/** A chat that can't end: one line, and its reasons one per line behind Details. */
function showCantEnd(reasons: readonly BotChatEndReason[]): void {
  const title = reasons.some(botChatEndReasonPermanent)
    ? translate('bots.endChat.cantEnd', "Can't end this chat")
    : translate('bots.endChat.cantEndYet', "Can't end yet")
  const id = toast.message(title, {
    action: {
      label: translate('bots.endChat.details', 'Details'),
      onClick: (event) => {
        event.preventDefault()
        toast.message(title, {
          id,
          description: reasons.map(botChatEndReasonText).join('\n'),
          descriptionClassName: 'whitespace-pre-line'
        })
      }
    }
  })
}

/** The row menu's End chat: nothing changes unless the host ends it. */
export async function endBotChatFromRow(bot: Bot, sessionId: string): Promise<boolean> {
  let result: BotChatEndResult
  try {
    result = await requestBotChatEnd(bot, { chat: sessionId, intent: 'end' })
  } catch {
    toast.message(translate('bots.endChat.unconfirmed', "Couldn't confirm the chat ended"))
    return false
  }
  switch (result.outcome) {
    case 'ended':
    case 'already-ended':
      showEnded(bot, sessionId)
      return true
    case 'kept':
      showCantEnd(result.reasons)
      return false
    case 'refused':
      toast.message(translate('bots.endChat.cantEnd', "Can't end this chat"))
      return false
    case 'superseded':
      showCantEnd([{ kind: 'reopened' }])
      return false
    case 'unknown':
      toast.message(translate('bots.endChat.unconfirmed', "Couldn't confirm the chat ended"))
      return false
  }
}

/** A tab's "x": one line for a proven outcome only; the Home Chat and anything uncertain say nothing. */
export function showBotChatTabCloseResult(
  bot: Bot,
  sessionId: string,
  result: BotChatEndResult
): void {
  if (result.outcome === 'ended') {
    showEnded(bot, sessionId)
    return
  }
  if (result.outcome === 'refused' && result.refusal.kind === 'linked' && result.background) {
    toast.message(translate('bots.endChat.keptLinked', 'Kept in background (linked to a thread)'))
    return
  }
  if (result.outcome === 'kept' && result.background) {
    toast.message(translate('bots.endChat.kept', 'Kept in background'))
  }
}
