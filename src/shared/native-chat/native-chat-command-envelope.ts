// Claude-family skill envelopes must resurface as user text or replies lose their prompt. Catalog commands remain noise,
// with local Ran /x feedback; ordinary non-catalog envelopes recover typed /name args.

import { isTextBlock, type NativeChatMessage } from '../native-chat-types'

const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/

export type NativeChatCommandEnvelope = { name: string; args: string }

/** Parse only leading envelope tags so ordinary prompts/XML pastes remain literal. */
export function parseNativeChatCommandEnvelope(text: string): NativeChatCommandEnvelope | null {
  const trimmed = text.trimStart()
  if (!trimmed.toLowerCase().startsWith('<command-')) {
    return null
  }
  const name = COMMAND_NAME.exec(trimmed)?.[1]?.trim()
  if (!name) {
    return null
  }
  return { name, args: COMMAND_ARGS.exec(trimmed)?.[1]?.trim() ?? '' }
}

/** Restore skill /name args for visible user turns and optimistic-echo matching. Keep catalog command envelopes hidden behind local Ran markers. */
export function surfaceSkillInvocationUserTurns(
  messages: readonly NativeChatMessage[],
  catalogCommandNames: ReadonlySet<string>
): NativeChatMessage[] {
  let changed = false
  const out = messages.map((message) => {
    if (message.role !== 'user' || !message.blocks.every(isTextBlock)) {
      return message
    }
    const envelope = parseNativeChatCommandEnvelope(
      message.blocks.map((block) => block.text).join('\n')
    )
    if (!envelope || catalogCommandNames.has(envelope.name.replace(/^\//, ''))) {
      return message
    }
    // Plugin envelopes canonicalize /plugin:name; restore the picked short name so the bubble matches typed input and prunes its optimistic echo.
    const shortName = envelope.name.replace(/^\//, '').split(':').at(-1) ?? ''
    const token = `/${shortName}`
    changed = true
    return {
      ...message,
      blocks: [{ type: 'text' as const, text: envelope.args ? `${token} ${envelope.args}` : token }]
    }
  })
  return changed ? out : (messages as NativeChatMessage[])
}
