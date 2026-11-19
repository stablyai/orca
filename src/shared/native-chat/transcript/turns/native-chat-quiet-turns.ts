import { isQuietBotResult, quietBotResultText } from '../../../bot-quiet-result'
import { isNativeChatOrcaCard } from '../../native-chat-orca-card'
import type { NativeChatMessage } from '../../native-chat-types'
import { deriveNativeChatRowContent } from '../row-content/native-chat-row-content'
import { nativeChatActingTurnKeys } from './native-chat-acting-turns'

function fromOtherAgent(message: NativeChatMessage): boolean {
  return message.role === 'user' && message.from !== undefined
}

/** Settled turns no person asked for (a hidden card answer, or another agent's message such as a
 *  worker's update) that ended with only the quiet marker and did nothing others see. Their rows
 *  and their "Worked for" bar don't draw; Orca's cards and the other agent's message still do.
 *  `keepsTurn` keeps a turn that left something else to show, such as a diff. A turn that also
 *  holds someone's message (steered in, or a connector delivery joining it) always draws. */
export function nativeChatQuietTurns(
  rows: readonly NativeChatMessage[],
  turnKeys: readonly (string | undefined)[],
  settledTurnKeys: ReadonlySet<string>,
  keepsTurn: (turnKey: string) => boolean
): { rows: ReadonlySet<number>; turns: ReadonlySet<string> } {
  const opened = new Set<string>()
  const asked = new Set<string>()
  const lastWords = new Map<string, string>()
  rows.forEach((message, index) => {
    const key = turnKeys[index]
    if (key === undefined) {
      return
    }
    if (message.orcaNotice === 'card-answer' || fromOtherAgent(message)) {
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
  const acting = nativeChatActingTurnKeys(rows, turnKeys)
  const turns = new Set(
    [...opened].filter((key) => {
      const words = lastWords.get(key)
      return (
        settledTurnKeys.has(key) &&
        !asked.has(key) &&
        !acting.has(key) &&
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
    const shown =
      (isNativeChatOrcaCard(message) && message.orcaNotice !== 'card-answer') ||
      fromOtherAgent(message)
    if (key !== undefined && turns.has(key) && !shown) {
      hidden.add(index)
    }
  })
  return { rows: hidden, turns }
}
