import type { NativeChatMessage } from '../../native-chat-types'
import { isQuietBotResult } from '../../../bot-quiet-result'
import { nativeChatBotMessageCardOf } from '../../bot-cards/native-chat-bot-card-kind'

// The bot CLI's commands that post where someone else reads them.
const POSTS = /\b(?:slack\s+(?:post|attach)|bot\s+reply|linear\s+(?:comment|create))\b/

function toolCommand(input: unknown): string {
  const command =
    typeof input === 'object' && input !== null && 'command' in input ? input.command : input
  return Array.isArray(command) ? command.join(' ') : typeof command === 'string' ? command : ''
}

function rowActs(message: NativeChatMessage): boolean {
  return (
    message.botItemNote?.by === 'bot' ||
    message.agentStart === true ||
    message.automationSaved !== undefined ||
    nativeChatBotMessageCardOf(message) !== null ||
    message.blocks.some(
      (block) => block.type === 'tool-call' && POSTS.test(toolCommand(block.input))
    )
  )
}

/** The quiet turns where the bot did something others see: changed an item, started a worker, saved
 *  an automation or posted to a source. Its quiet result there is not "nothing to report". */
export function nativeChatActingTurnKeys(
  rows: readonly NativeChatMessage[],
  turnKeys: readonly (string | undefined)[]
): ReadonlySet<string> {
  const quiet = new Set(
    rows.flatMap((message, index) => {
      const key = turnKeys[index]
      const ended =
        message.role === 'assistant' &&
        message.blocks.some((block) => block.type === 'text' && isQuietBotResult(block.text))
      return key !== undefined && ended ? [key] : []
    })
  )
  if (quiet.size === 0) {
    return quiet
  }
  return new Set(
    rows.flatMap((message, index) => {
      const key = turnKeys[index]
      return key !== undefined && quiet.has(key) && rowActs(message) ? [key] : []
    })
  )
}
