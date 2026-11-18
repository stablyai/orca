// Start, Dismiss and Look now for a bot's Up next, through its host.
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { openBotHomeTab } from '@/lib/bot-catalog'
import { callBotRpc } from '@/lib/bot-hosts'
import type { Bot } from '../../../../shared/bot-types'

/** The host's refusal code, from a runtime error's message. */
function refusalCode(error: unknown): string {
  return error instanceof Error ? error.message : ''
}

function lookNowRefusalText(code: string): string {
  if (code.includes('look_now_running')) {
    return translate('bots.upNext.lookNowRunning', 'Already looking around.')
  }
  if (code.includes('look_now_paused')) {
    return translate('bots.upNext.lookNowPaused', 'Turn the bot on to look around.')
  }
  return translate('bots.upNext.lookNowFailed', 'Could not start a look. Try again.')
}

/** Puts the suggestion's request in the bot's Home message box, unsent. */
export async function startSuggestion(bot: Bot, suggestionId: string): Promise<void> {
  try {
    const { ask } = await callBotRpc<{ ask: string }>(bot, 'bots.suggestions.start', {
      botId: bot.id,
      suggestionId
    })
    await openBotHomeTab(bot, { draft: ask })
  } catch (error) {
    console.error('Failed to start a suggestion:', error)
    toast.error(translate('bots.upNext.startFailed', 'That suggestion is no longer listed.'))
  }
}

export async function dismissSuggestion(bot: Bot, suggestionId: string): Promise<void> {
  try {
    await callBotRpc(bot, 'bots.suggestions.dismiss', {
      botId: bot.id,
      suggestionId
    })
  } catch (error) {
    console.error('Failed to dismiss a suggestion:', error)
  }
}

/** False when the host would not start one; it says why. */
export async function lookNow(bot: Bot): Promise<boolean> {
  try {
    await callBotRpc(bot, 'bots.lookAround.lookNow', { botId: bot.id })
    return true
  } catch (error) {
    toast.message(lookNowRefusalText(refusalCode(error)))
    return false
  }
}
