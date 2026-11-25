import type { AgentJournalRenderItem } from '../journal/agent-session-journal-types'
import { isRootAgentJournalItem } from '../journal/agent-session-journal-producer'
import { connectorMessageShownBlocks } from '../../connector-asker-prompt'
import { isStructuredAgentSessionCommandEntry } from './structured-agent-session-command-entry'
import { sliceAtCodeUnitLimit } from '../../text/surrogate-safe-text-slice'
import { splitBotMentions } from '../../bots/bot-mention-context'
import { stripSentImagePromptMarkers } from '../../native-chat/transcript/images/native-chat-sent-image-prompt-markers'

export const STRUCTURED_CHAT_NAME_PROMPT_LIMIT = 4000

export function hasStructuredChatPromptText(prompt: string): boolean {
  return /[\p{L}\p{N}]/u.test(prompt)
}

export function firstStructuredAgentSessionPrompt(
  items: readonly AgentJournalRenderItem[]
): string {
  for (const item of items) {
    const body = item.body
    if (
      body.kind !== 'message' ||
      body.role !== 'user' ||
      !isRootAgentJournalItem(item) ||
      isStructuredAgentSessionCommandEntry(body) ||
      // Orca's own turns (a bot's kickoff, a card click, a takeover) are not what was asked.
      (body.origin !== undefined && body.origin !== 'connector')
    ) {
      continue
    }
    let prompt = ''
    const blocks = connectorMessageShownBlocks(body)
    const imageCount = blocks.filter((block) => block.type === 'image-ref').length
    for (const block of blocks) {
      if (block.type === 'text') {
        if (prompt) {
          prompt += '\n'
        }
        // A title names what was asked; `[Image #N]` only says where an image sat.
        prompt += sliceAtCodeUnitLimit(
          splitBotMentions(stripSentImagePromptMarkers(block.text, imageCount))
            .map((part) => (typeof part === 'string' ? part : `@${part.name}`))
            .join(''),
          STRUCTURED_CHAT_NAME_PROMPT_LIMIT - prompt.length
        )
        if (prompt.length >= STRUCTURED_CHAT_NAME_PROMPT_LIMIT) {
          break
        }
      }
    }
    if (hasStructuredChatPromptText(prompt)) {
      return prompt.trim()
    }
  }
  return ''
}
