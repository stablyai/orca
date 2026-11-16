import { unwrapClaudePastedContent } from '../../../agent-hook-listener/providers/claude/transcripts/claude-pasted-content'
import {
  stripAnsiEscapeSequences,
  TERMINAL_CONTROL_CHARACTER_PATTERN
} from '../../../terminal/protocol/escape/ansi-escape-sequences'
import { isTextBlock, type NativeChatBlock, type NativeChatMessage } from '../../native-chat-types'
import {
  IMAGE_PROMPT_MARKER,
  stripImagePromptMarker
} from './native-chat-sent-image-prompt-markers'

// Keep whitespace and path starts disjoint so incomplete markers cannot rescan their suffix.
const IMAGE_SOURCE_MARKER = /^\[Image:\s*source:\s*(\S.*?|[^\S\r\n\u2028\u2029])\]\s*$/

export function imageSourcePathFromText(text: string): string | null {
  return text.match(IMAGE_SOURCE_MARKER)?.[1]?.trim() ?? null
}

const imageSourcePaths = new WeakMap<NativeChatMessage['blocks'], string[]>()
const imagePromptMarkers = new WeakMap<NativeChatMessage['blocks'], boolean>()

/** Source paths only from all-text turns whose every block is an image-source marker. Claude groups multi-image pastes into one turn;
 * requiring one block misses them, while accepting mixed blocks would hide real prompts. */
export function imageSourcePathsFromMessage(message: NativeChatMessage): string[] {
  if (message.role !== 'user') {
    return []
  }
  const cached = imageSourcePaths.get(message.blocks)
  if (cached) {
    return cached
  }
  const paths = deriveImageSourcePaths(message)
  imageSourcePaths.set(message.blocks, paths)
  return paths
}

function deriveImageSourcePaths(message: NativeChatMessage): string[] {
  const paths: string[] = []
  for (const block of message.blocks) {
    if (!isTextBlock(block)) {
      return []
    }
    const path = imageSourcePathFromText(block.text)
    if (path === null) {
      return []
    }
    paths.push(path)
  }
  return paths
}

export function isImageSourceUserTurn(message: NativeChatMessage): boolean {
  return imageSourcePathsFromMessage(message).length > 0
}

/** Normalizes PTY-backed user text into the pending-echo comparison key. */
export function normalizeNativeChatUserText(text: string): string {
  // Strip sequences first so their printable tails cannot survive a lone-control pass.
  return stripImagePromptMarker(
    stripAnsiEscapeSequences(unwrapClaudePastedContent(text)).replace(
      TERMINAL_CONTROL_CHARACTER_PATTERN,
      ''
    )
  )
    .trim()
    .replace(/\s+/g, ' ')
}

export function normalizedNativeChatUserMessageText(message: NativeChatMessage): string | null {
  if (message.role !== 'user') {
    return null
  }
  const normalized = normalizeNativeChatUserText(
    message.blocks
      .filter(isTextBlock)
      .map((block) => unwrapClaudePastedContent(block.text))
      .join(' ')
  )
  return normalized || null
}

function stripImagePromptMarkersFromTextBlocks(
  blocks: readonly NativeChatBlock[]
): NativeChatBlock[] {
  let sawText = false
  let next: NativeChatBlock[] | null = null
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!
    if (!isTextBlock(block)) {
      next?.push(block)
      continue
    }
    const isFirstText = !sawText
    sawText = true
    const text = stripImagePromptMarker(block.text)
    if (!text.trim() && (text !== block.text || isFirstText)) {
      next ??= blocks.slice(0, index)
      continue
    }
    if (text !== block.text) {
      next ??= blocks.slice(0, index)
      next.push({ ...block, text })
      continue
    }
    next?.push(block)
  }
  return next ?? (blocks as NativeChatBlock[])
}

export function hasImagePromptMarker(message: NativeChatMessage): boolean {
  const cached = imagePromptMarkers.get(message.blocks)
  if (cached !== undefined) {
    return cached
  }
  const hasMarker = message.blocks.some(
    (block) => isTextBlock(block) && IMAGE_PROMPT_MARKER.test(block.text)
  )
  imagePromptMarkers.set(message.blocks, hasMarker)
  return hasMarker
}

function isImagePromptTurn(message: NativeChatMessage | undefined): message is NativeChatMessage {
  return message?.role === 'user' && hasImagePromptMarker(message)
}

/** Consecutive source turns and their prompt form one preparation dependency. Claude writes the
 *  prompt first and its source turns right after; a prompt following its sources is also folded. */
export function nativeChatImageTranscriptUnits(
  messages: readonly NativeChatMessage[]
): NativeChatMessage[][] {
  const units: NativeChatMessage[][] = []
  for (let index = 0; index < messages.length; index += 1) {
    const first = messages[index]!
    const members = [first]
    const sourceFirst = isImageSourceUserTurn(first)
    if (sourceFirst || isImagePromptTurn(first)) {
      while (index + 1 < messages.length) {
        const next = messages[index + 1]!
        if (next.source !== first.source || !isImageSourceUserTurn(next)) {
          break
        }
        members.push(next)
        index += 1
      }
      const prompt = messages[index + 1]
      if (sourceFirst && prompt?.source === first.source && isImagePromptTurn(prompt)) {
        members.push(prompt)
        index += 1
      }
    }
    units.push(members)
  }
  return units
}

/** Claude records image paths as source turns next to a prompt carrying image
 *  markers. Merge the whole run back into one native user turn. */
export function normalizeImageTranscriptMessages(
  messages: readonly NativeChatMessage[]
): NativeChatMessage[] {
  const rows = nativeChatImageTranscriptUnits(messages).flatMap(normalizeImageTranscriptUnit)
  return rows.length === messages.length && rows.every((row, index) => row === messages[index])
    ? (messages as NativeChatMessage[])
    : rows
}

/** The unit's one non-source row, wherever Claude wrote it relative to its sources. */
export function imageTranscriptUnitPrompt(
  unit: readonly NativeChatMessage[]
): NativeChatMessage | undefined {
  return unit.find((message) => !isImageSourceUserTurn(message))
}

export function normalizeImageTranscriptUnit(
  messages: readonly NativeChatMessage[]
): NativeChatMessage[] {
  const prompt = imageTranscriptUnitPrompt(messages)
  const sources = messages.filter((message) => message !== prompt)
  if (sources.length > 0) {
    const images = (source: NativeChatMessage) =>
      imageSourcePathsFromMessage(source).map((path) => ({ type: 'image-ref' as const, path }))
    return prompt
      ? [
          {
            ...prompt,
            blocks: [
              ...sources.flatMap(images),
              ...stripImagePromptMarkersFromTextBlocks(prompt.blocks)
            ]
          }
        ]
      : sources.map((source) => ({ ...source, blocks: images(source) }))
  }
  const first = messages[0]!
  if (first.role !== 'user') {
    return messages as NativeChatMessage[]
  }
  const blocks = stripImagePromptMarkersFromTextBlocks(first.blocks)
  return blocks === first.blocks ? (messages as NativeChatMessage[]) : [{ ...first, blocks }]
}
