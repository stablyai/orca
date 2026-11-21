import { isTextBlock, type NativeChatBlock, type NativeChatMessage } from '../../native-chat-types'
import { withoutSentImagePromptMarkers } from '../images/native-chat-sent-image-prompt-markers'

export type NativeChatSentPromptReference = { text: string }

export type NativeChatSentPromptReferences = {
  /** The user's own words, without the trailing machine block the send appended. */
  visibleContent: string
  references: readonly NativeChatSentPromptReference[]
}

const USER_SELECT_TAIL = /(?:\n\n)?# userselect:\n```userselect\n([\s\S]*?)\n```\s*$/
/** Read-only: messages sent before the text-only payload may carry the complete source objects. */
const LEGACY_SELECT_TAIL =
  /(?:\n\n)?# Conversation selections:\n```zcode-conversation-selections\n([\s\S]*?)\n```\s*$/
const EMPTY_REFERENCES: readonly NativeChatSentPromptReference[] = Object.freeze([])
const referencesByBlocks = new WeakMap<
  readonly NativeChatBlock[],
  readonly NativeChatSentPromptReference[]
>()
const withoutReferences = new WeakMap<readonly NativeChatBlock[], NativeChatBlock[]>()

/** The selected words after the user's own words, when the send carried any. */
export function parseNativeChatSentPromptReferences(
  content: string
): NativeChatSentPromptReferences {
  const current = content.match(USER_SELECT_TAIL)
  if (current) {
    return readSelectionTail(content, current)
  }
  const legacy = content.match(LEGACY_SELECT_TAIL)
  return legacy ? readSelectionTail(content, legacy) : { visibleContent: content, references: [] }
}

function readSelectionTail(
  content: string,
  tail: RegExpMatchArray
): NativeChatSentPromptReferences {
  try {
    const parsed: unknown = JSON.parse(tail[1] ?? '[]')
    if (!Array.isArray(parsed) || parsed.some((value) => !isSentReferenceText(value))) {
      throw new Error('invalid selection block')
    }
    return {
      visibleContent: content.slice(0, tail.index ?? 0).trimEnd(),
      references: parsed.map((value) => ({ text: value.text }))
    }
  } catch {
    // Malformed history stays as the user sees it rather than hiding words behind a bad guess.
    return { visibleContent: content, references: [] }
  }
}

function isSentReferenceText(value: unknown): value is NativeChatSentPromptReference {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'text' in value &&
    typeof value.text === 'string'
  )
}

export function stripNativeChatSentPromptReferences(content: string): string {
  return parseNativeChatSentPromptReferences(content).visibleContent
}

/** One user message's selected words, from its raw blocks; a non-user row never carries any. */
export function nativeChatSentPromptReferences(
  message: Pick<NativeChatMessage, 'role' | 'blocks'>
): readonly NativeChatSentPromptReference[] {
  if (message.role !== 'user') {
    return EMPTY_REFERENCES
  }
  const cached = referencesByBlocks.get(message.blocks)
  if (cached) {
    return cached
  }
  const references = message.blocks.flatMap((block) =>
    isTextBlock(block) ? parseNativeChatSentPromptReferences(block.text).references : []
  )
  referencesByBlocks.set(message.blocks, references)
  return references
}

/** A user message's blocks as the transcript draws them: its words, less the sent selection tail. */
export function withoutSentNativeChatPromptReferences(
  message: Pick<NativeChatMessage, 'role' | 'blocks'>
): NativeChatBlock[] {
  if (message.role !== 'user') {
    return message.blocks
  }
  const cached = withoutReferences.get(message.blocks)
  if (cached) {
    return cached
  }
  let changed = false
  const blocks = message.blocks.flatMap((block): NativeChatBlock[] => {
    if (!isTextBlock(block)) {
      return [block]
    }
    const visibleContent = stripNativeChatSentPromptReferences(block.text)
    if (visibleContent === block.text) {
      return [block]
    }
    changed = true
    return visibleContent.trim() ? [{ ...block, text: visibleContent }] : []
  })
  const result = changed ? blocks : message.blocks
  withoutReferences.set(message.blocks, result)
  return result
}

export function nativeChatVisibleMessageBlocks(
  message: Pick<NativeChatMessage, 'role' | 'blocks'>
): NativeChatBlock[] {
  const blocks = withoutSentNativeChatPromptReferences(message)
  return withoutSentImagePromptMarkers(blocks === message.blocks ? message : { ...message, blocks })
}
