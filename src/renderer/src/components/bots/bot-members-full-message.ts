// Who can ask: what an add refused for a limit says (who, and which limit). Saves nobody.
import type { Translate } from '@/i18n/use-translate'
import { readBotMembersFull } from '../../../../shared/bots/bot-member-capacity'

/** The words for `error` when it is a refused add, else null. */
export function botMembersFullMessage(error: unknown, t: Translate): string | null {
  const full = readBotMembersFull(error)
  if (!full) {
    return null
  }
  const values = { names: full.names.join(', '), count: full.limit }
  return full.scope === 'bot'
    ? t(
        'bots.whoCanAsk.fullBot',
        'Nobody was added: {{names}} would go past the {{count}} people a bot can have.',
        values
      )
    : t(
        'bots.whoCanAsk.fullWorkspace',
        'Nobody was added: {{names}} would go past the {{count}} people this workspace can have.',
        values
      )
}
