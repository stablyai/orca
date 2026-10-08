import { normalizeAgentSessionConversationName } from './agent-session-conversation-name'
import { cleanGeneratedCommitMessage } from './commit-message-agent-output'
import { sliceAtCodeUnitLimit } from './surrogate-safe-text-slice'

export type ConversationNameContext = { firstPrompt: string }

const MAX_FIRST_PROMPT_LENGTH = 4000
const MAX_GENERATED_NAME_LENGTH = 48

export function clampConversationNameFirstPrompt(firstPrompt: string): string {
  return sliceAtCodeUnitLimit(firstPrompt.trim(), MAX_FIRST_PROMPT_LENGTH)
}

export function buildConversationNamePrompt(
  context: ConversationNameContext,
  customPrompt = ''
): string {
  const firstPrompt = clampConversationNameFirstPrompt(context.firstPrompt)
  const basePrompt = `Name this chat from the user's first request.
Write a short, specific title of at most ${MAX_GENERATED_NAME_LENGTH} characters.
Output only the title, with no heading, quotes, or explanation.

First request:
${firstPrompt}`
  const extra = customPrompt.trim()
  return extra ? `${basePrompt}\n\nAdditional instructions:\n${extra}` : basePrompt
}

export function sanitizeGeneratedConversationName(raw: string): string | null {
  const cleaned = cleanGeneratedCommitMessage(raw)
  if (cleaned.startsWith('<think>') || cleaned.startsWith('◁think▷')) {
    return null
  }
  const firstLine = cleaned.split(/\r?\n/u).find((line) => line.trim().length > 0)
  if (!firstLine) {
    return null
  }

  let name = firstLine
    .trim()
    .replace(/^#{1,6}\s*/u, '')
    .trim()
  for (;;) {
    const unwrapped = name
      .replace(/^(\*\*|__)(.*?)\1$/u, '$2')
      .replace(/^("|'|`)(.*?)\1$/u, '$2')
      .replace(/^“(.*)”$/u, '$1')
      .replace(/^‘(.*)’$/u, '$1')
      .replace(/^title\s*:\s*/iu, '')
      .trim()
    if (unwrapped === name) {
      break
    }
    name = unwrapped
  }
  name = normalizeAgentSessionConversationName(name) ?? ''
  if (!name) {
    return null
  }
  if (name.length > MAX_GENERATED_NAME_LENGTH) {
    const clipped = sliceAtCodeUnitLimit(name, MAX_GENERATED_NAME_LENGTH)
    const boundary = clipped.lastIndexOf(' ')
    name =
      boundary >= Math.floor(MAX_GENERATED_NAME_LENGTH / 2) ? clipped.slice(0, boundary) : clipped
  }
  return normalizeAgentSessionConversationName(name)
}
