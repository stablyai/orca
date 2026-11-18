import { isQuietBotResult, quietBotResultText } from '../../../bot-quiet-result'
import { isNativeChatOrcaCard } from '../../native-chat-orca-card'
import type { NativeChatMessage } from '../../native-chat-types'
import { deriveNativeChatRowContent } from '../row-content/native-chat-row-content'

/** Rows of settled turns that a hidden card answer opened and the bot ended with only the quiet
 *  marker: the owner saw no ask and the bot had nothing to say, so only Orca's cards from it draw.
 *  `keepsTurn` keeps a turn that left something else to show, such as a diff. A turn that also
 *  holds someone's message (steered in, or a connector delivery joining it) always draws. */
export function nativeChatQuietCardAnswerRows(
  rows: readonly NativeChatMessage[],
  turnKeys: readonly (string | undefined)[],
  settledTurnKeys: ReadonlySet<string>,
  keepsTurn: (turnKey: string) => boolean
): ReadonlySet<number> {
  const opened = new Set<string>()
  const asked = new Set<string>()
  const lastWords = new Map<string, string>()
  rows.forEach((message, index) => {
    const key = turnKeys[index]
    if (key === undefined) {
      return
    }
    if (message.orcaNotice === 'card-answer') {
      opened.add(key)
    } else if (message.role === 'user') {
      asked.add(key)
    }
    if (message.role === 'assistant') {
      const words = deriveNativeChatRowContent(message.blocks).markdown
      if (words.trim()) {
        lastWords.set(key, words)
      }
    }
  })
  const quiet = new Set(
    [...opened].filter((key) => {
      const words = lastWords.get(key)
      return (
        settledTurnKeys.has(key) &&
        !asked.has(key) &&
        words !== undefined &&
        isQuietBotResult(words) &&
        quietBotResultText(words) === '' &&
        !keepsTurn(key)
      )
    })
  )
  const hidden = new Set<number>()
  rows.forEach((message, index) => {
    const key = turnKeys[index]
    const card = isNativeChatOrcaCard(message) && message.orcaNotice !== 'card-answer'
    if (key !== undefined && quiet.has(key) && !card) {
      hidden.add(index)
    }
  })
  return hidden
}
