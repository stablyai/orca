import { normalizeAgentSessionConversationName } from './agent-session/agent-session-conversation-name'
import { cleanGeneratedCommitMessage } from './commit-message-agent-output'
import { sliceAtCodeUnitLimit } from './surrogate-safe-text-slice'

export type ConversationNameContext = { firstPrompt: string }

const MAX_FIRST_PROMPT_LENGTH = 4000
const MAX_GENERATED_NAME_LENGTH = 48

export function clampConversationNameFirstPrompt(firstPrompt: string): string {
  return sliceAtCodeUnitLimit(firstPrompt.trim(), MAX_FIRST_PROMPT_LENGTH)
}

/** The naming request's first line; Session History reads it to hide these one-shot runs. */
export const CONVERSATION_NAME_PROMPT_OPENING = "Name this chat from the user's first request."

export function buildConversationNamePrompt(
  context: ConversationNameContext,
  customPrompt = ''
): string {
  const firstPrompt = clampConversationNameFirstPrompt(context.firstPrompt)
  const basePrompt = `${CONVERSATION_NAME_PROMPT_OPENING}
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
      .replace(/^\u201C(.*)\u201D$/u, '$1')
      .replace(/^\u2018(.*)\u2019$/u, '$1')
      .replace(/^title\s*:\s*/iu, '')
      .trim()
    if (unwrapped === name) {
      break
    }
    name = unwrapped
  }
  name = normalizeAgentSessionConversationName(name) ?? ''
  return name ? normalizeAgentSessionConversationName(clipConversationName(name)) : null
}

/** Seed a real name so failed generation cannot strand the placeholder. */
export function conversationNameSeed(firstPrompt: string): string | null {
  const prompt = normalizeAgentSessionConversationName(firstPrompt)
  if (!prompt) {
    return null
  }
  const clipped = clipConversationName(prompt)
  return normalizeAgentSessionConversationName(clipped === prompt ? prompt : `${clipped}…`)
}

function clipConversationName(name: string): string {
  if (name.length <= MAX_GENERATED_NAME_LENGTH) {
    return name
  }
  const clipped = sliceAtCodeUnitLimit(name, MAX_GENERATED_NAME_LENGTH)
  const boundary = clipped.lastIndexOf(' ')
  return boundary >= Math.floor(MAX_GENERATED_NAME_LENGTH / 2)
    ? clipped.slice(0, boundary)
    : clipped
}
