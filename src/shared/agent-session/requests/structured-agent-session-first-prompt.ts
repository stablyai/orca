import type { AgentJournalRenderItem } from '../journal/agent-session-journal-types'
import { isRootAgentJournalItem } from '../journal/agent-session-journal-producer'
import { connectorMessageShownBlocks } from '../../connector-asker-prompt'
import { isStructuredAgentSessionCommandEntry } from './structured-agent-session-command-entry'
import { sliceAtCodeUnitLimit } from '../../text/surrogate-safe-text-slice'
import { splitBotMentions } from '../../bots/bot-mention-context'
import { stripSentImagePromptMarkers } from '../../native-chat/transcript/images/native-chat-sent-image-prompt-markers'

export const STRUCTURED_CHAT_NAME_PROMPT_LIMIT = 4000
/** Joined regenerate context: first-prompt head plus later-turn tail. */
export const STRUCTURED_CHAT_REGENERATE_NAME_PROMPT_LIMIT = 12000

export function hasStructuredChatPromptText(prompt: string): boolean {
  return /[\p{L}\p{N}]/u.test(prompt)
}

export function firstStructuredAgentSessionPrompt(
  items: readonly AgentJournalRenderItem[]
): string {
  for (const item of items) {
    const prompt = structuredAgentSessionPromptFromItem(item)
    if (prompt) {
      return prompt
    }
  }
  return ''
}

export function structuredAgentSessionUserPrompts(
  items: readonly AgentJournalRenderItem[]
): string[] {
  const prompts: string[] = []
  for (const item of items) {
    const prompt = structuredAgentSessionPromptFromItem(item)
    if (prompt) {
      prompts.push(prompt)
    }
  }
  return prompts
}

const NAMING_PROMPT_SEPARATOR = '\n…\n'
/** Slack for the `N. ` prefix while a long chat is still being paged. */
const NAMING_PROMPT_NUMBER_SLACK = 8

/** Numbered user turns for a person-asked rename; a single turn stays unnumbered. */
export function joinStructuredChatNamingPrompts(prompts: readonly string[]): string {
  if (prompts.length === 0) {
    return ''
  }
  if (prompts.length === 1) {
    return prompts[0] ?? ''
  }
  const joined = prompts.map((prompt, index) => `${index + 1}. ${prompt}`).join('\n')
  if (joined.length <= STRUCTURED_CHAT_REGENERATE_NAME_PROMPT_LIMIT) {
    return joined
  }
  const head = sliceAtCodeUnitLimit(joined, STRUCTURED_CHAT_NAME_PROMPT_LIMIT)
  const tailBudget =
    STRUCTURED_CHAT_REGENERATE_NAME_PROMPT_LIMIT - head.length - NAMING_PROMPT_SEPARATOR.length
  const tailStart = joined.length - Math.max(0, tailBudget)
  return `${head}${NAMING_PROMPT_SEPARATOR}${sliceFromCodeUnit(joined, tailStart)}`
}

/** Keeps the opening turns and a rolling tail so a long chat still names its latest messages. */
export function createStructuredChatNamingPromptWindow(): {
  add: (prompt: string) => void
  prompts: () => string[]
} {
  const head: string[] = []
  const tail: string[] = []
  let headUnits = 0
  let tailUnits = 0
  let overflow = false
  const cost = (prompt: string) => prompt.length + NAMING_PROMPT_NUMBER_SLACK
  const trimTail = () => {
    const budget =
      STRUCTURED_CHAT_REGENERATE_NAME_PROMPT_LIMIT - headUnits - NAMING_PROMPT_SEPARATOR.length
    while (tail.length > 1 && tailUnits > budget) {
      const removed = tail.shift()
      if (removed) {
        tailUnits -= cost(removed)
      }
    }
  }
  return {
    add(prompt: string) {
      const units = cost(prompt)
      if (!overflow && headUnits + units <= STRUCTURED_CHAT_REGENERATE_NAME_PROMPT_LIMIT) {
        head.push(prompt)
        headUnits += units
        return
      }
      if (!overflow) {
        overflow = true
        while (head.length > 0 && headUnits > STRUCTURED_CHAT_NAME_PROMPT_LIMIT) {
          const moved = head.pop()
          if (!moved) {
            break
          }
          const movedUnits = cost(moved)
          headUnits -= movedUnits
          tail.unshift(moved)
          tailUnits += movedUnits
        }
      }
      tail.push(prompt)
      tailUnits += units
      trimTail()
    },
    prompts: () => head.concat(tail)
  }
}

function structuredAgentSessionPromptFromItem(item: AgentJournalRenderItem): string {
  const body = item.body
  if (
    body.kind !== 'message' ||
    body.role !== 'user' ||
    !isRootAgentJournalItem(item) ||
    isStructuredAgentSessionCommandEntry(body) ||
    // Orca's own turns (a bot's kickoff, a card click, a takeover) are not what was asked.
    (body.origin !== undefined && body.origin !== 'connector')
  ) {
    return ''
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
  const trimmed = prompt.trim()
  return hasStructuredChatPromptText(trimmed) ? trimmed : ''
}

function sliceFromCodeUnit(value: string, start: number): string {
  if (start <= 0) {
    return value
  }
  if (start >= value.length) {
    return ''
  }
  const code = value.charCodeAt(start)
  const index = code >= 0xdc00 && code <= 0xdfff ? start + 1 : start
  return value.slice(index)
}
