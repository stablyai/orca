// Claude-family harnesses record a slash input's user turn as a command
// envelope (`<command-name>/x</command-name>…`), not as the typed text. The
// noise filter rightly hides those for catalog commands — Orca shows a local
// `Ran /x` line instead — but a skill invocation IS the user's chat turn, so
// dropping its envelope makes the assistant appear to answer an empty
// conversation. Surface non-catalog envelopes back as plain user text.

import { isTextBlock, type NativeChatMessage } from './native-chat-types'

const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/

export type NativeChatCommandEnvelope = { name: string; args: string }

/** Parse a user turn recorded as a command envelope. Returns null for any text
 *  that does not lead with an envelope tag (ordinary prompts, XML pastes). */
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

/**
 * Replace skill-invocation envelopes with the token the user sent (`/name
 * args`) so the turn renders as their message and the optimistic echo can
 * reconcile against it. Catalog commands stay untouched — the noise filter
 * hides them and the local `Ran /name` marker is their feedback.
 */
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
    // Why: the harness canonicalizes a plugin skill to `/plugin:name`, but the
    // user (and the picker) sent the short frontmatter name. Render the short
    // token so the bubble shows what was typed and the optimistic echo prunes
    // instead of duplicating the turn.
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
