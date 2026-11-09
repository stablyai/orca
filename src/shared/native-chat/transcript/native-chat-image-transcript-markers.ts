import { unwrapClaudePastedContent } from '../../claude-pasted-content'
import {
  stripAnsiEscapeSequences,
  TERMINAL_CONTROL_CHARACTER_PATTERN
} from '../../ansi-escape-sequences'
import { isTextBlock, type NativeChatBlock, type NativeChatMessage } from '../native-chat-types'
import { imageReferenceToken, replaceImageReferences } from '../native-chat-image-reference'
import { NATIVE_CHAT_QUOTED_FILE_REFERENCE } from '../../agent-image-paste'

// Keep whitespace and path starts disjoint so incomplete markers cannot rescan their suffix.
const IMAGE_SOURCE_MARKER = /^\[Image:\s*source:\s*(\S.*?|[^\S\r\n\u2028\u2029])\]\s*$/
export const IMAGE_PROMPT_MARKER = /\[Image #\d+\]/
const IMAGE_PROMPT_MARKERS = /\[Image #\d+\]/g
// A quoted file reference is matched whole, so a path that reads like a marker is left as typed.
const IMAGE_PROMPT_MARKER_NUMBERS_OUTSIDE_FILE_REFERENCES = new RegExp(
  `(${NATIVE_CHAT_QUOTED_FILE_REFERENCE.source})|\\[Image #(\\d+)\\]`,
  'g'
)
const IMAGE_PROMPT_MARKER_AT_START = /^[^\S\r\n]*\[Image #\d+\]/
const IMAGE_PROMPT_MARKER_AT_END = /\[Image #\d+\][^\S\r\n]*$/
const HORIZONTAL_WHITESPACE_START = /^[^\S\r\n]+/
const HORIZONTAL_WHITESPACE_END = /[^\S\r\n]+$/

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

/** Map chips to sent-image [Image #N] positions, matching Claude/Codex TUIs; drop chips whose images were not sent. */
export function imageReferencesToPromptMarkers(
  text: string,
  sentImageIds: readonly string[]
): string {
  return replaceImageReferences(text, (attachmentId) => {
    const index = sentImageIds.indexOf(attachmentId)
    return index === -1 ? '' : `[Image #${index + 1}]`
  })
}

function replaceSentImagePromptMarkers(
  text: string,
  replace: (number: number, marker: string) => string
): string {
  return text.replace(
    IMAGE_PROMPT_MARKER_NUMBERS_OUTSIDE_FILE_REFERENCES,
    (match, fileReference: string | undefined, number: string) =>
      fileReference === undefined ? replace(Number(number), match) : match
  )
}

/** Restore sent markers as image chips; leave out-of-range numbers literal. */
export function promptMarkersToImageReferences(text: string, imageIds: readonly string[]): string {
  return replaceSentImagePromptMarkers(text, (number, marker) => {
    const attachmentId = imageIds[number - 1]
    return attachmentId === undefined ? marker : imageReferenceToken(attachmentId)
  })
}

/** Remove only markers belonging to this structured send’s imageCount; leave out-of-range numbers literal. */
export function stripSentImagePromptMarkers(text: string, imageCount: number): string {
  return withoutStrippedMarkerSpace(
    text,
    replaceSentImagePromptMarkers(text, (number, marker) =>
      number >= 1 && number <= imageCount ? '' : marker
    )
  )
}

export function stripImagePromptMarker(text: string): string {
  return withoutStrippedMarkerSpace(text, text.replace(IMAGE_PROMPT_MARKERS, ''))
}

function withoutStrippedMarkerSpace(text: string, stripped: string): string {
  if (stripped === text) {
    return text
  }
  let result = IMAGE_PROMPT_MARKER_AT_START.test(text)
    ? stripped.replace(HORIZONTAL_WHITESPACE_START, '')
    : stripped
  if (IMAGE_PROMPT_MARKER_AT_END.test(text)) {
    result = result.replace(HORIZONTAL_WHITESPACE_END, '')
  }
  return result
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

/** Consecutive source turns and their optional prompt form one preparation dependency. */
export function nativeChatImageTranscriptUnits(
  messages: readonly NativeChatMessage[]
): NativeChatMessage[][] {
  const units: NativeChatMessage[][] = []
  for (let index = 0; index < messages.length; index += 1) {
    const first = messages[index]!
    const members = [first]
    if (imageSourcePathsFromMessage(first).length > 0) {
      while (index + 1 < messages.length) {
        const next = messages[index + 1]!
        if (next.source !== first.source || imageSourcePathsFromMessage(next).length === 0) {
          break
        }
        members.push(next)
        index += 1
      }
      const prompt = messages[index + 1]
      if (
        prompt?.role === 'user' &&
        prompt.source === first.source &&
        hasImagePromptMarker(prompt)
      ) {
        members.push(prompt)
        index += 1
      }
    }
    units.push(members)
  }
  return units
}

/** Claude records image paths as source turns followed by a prompt carrying
 *  image markers. Merge the whole run back into one native user turn. */
export function normalizeImageTranscriptMessages(
  messages: readonly NativeChatMessage[]
): NativeChatMessage[] {
  const rows = nativeChatImageTranscriptUnits(messages).flatMap(normalizeImageTranscriptUnit)
  return rows.length === messages.length && rows.every((row, index) => row === messages[index])
    ? (messages as NativeChatMessage[])
    : rows
}

export function normalizeImageTranscriptUnit(
  messages: readonly NativeChatMessage[]
): NativeChatMessage[] {
  const first = messages[0]!
  if (imageSourcePathsFromMessage(first).length > 0) {
    const last = messages.at(-1)!
    const hasPrompt = imageSourcePathsFromMessage(last).length === 0
    const sources = hasPrompt ? messages.slice(0, -1) : messages
    const images = (source: NativeChatMessage) =>
      imageSourcePathsFromMessage(source).map((path) => ({ type: 'image-ref' as const, path }))
    return hasPrompt
      ? [
          {
            ...last,
            blocks: [
              ...sources.flatMap(images),
              ...stripImagePromptMarkersFromTextBlocks(last.blocks)
            ]
          }
        ]
      : sources.map((source) => ({ ...source, blocks: images(source) }))
  }
  if (first.role !== 'user') {
    return messages as NativeChatMessage[]
  }
  const blocks = stripImagePromptMarkersFromTextBlocks(first.blocks)
  return blocks === first.blocks ? (messages as NativeChatMessage[]) : [{ ...first, blocks }]
}
