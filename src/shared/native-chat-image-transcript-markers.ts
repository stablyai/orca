import { unwrapClaudePastedContent } from './claude-pasted-content'
import {
  stripAnsiEscapeSequences,
  TERMINAL_CONTROL_CHARACTER_PATTERN
} from './ansi-escape-sequences'
import { isTextBlock, type NativeChatBlock, type NativeChatMessage } from './native-chat-types'
import { imageReferenceToken, replaceImageReferences } from './native-chat-image-reference'
import { NATIVE_CHAT_QUOTED_FILE_REFERENCE } from './agent-image-paste'

const IMAGE_SOURCE_MARKER = /^\[Image:\s*source:\s*(.+?)\]\s*$/
const IMAGE_PROMPT_MARKER = /\[Image #\d+\]/
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

/** Every image-source path a user turn carries, or [] when it is not a pure
 *  image-source turn.
 *
 *  Why not `soleText`: Claude records a multi-image paste as ONE companion message
 *  holding one `[Image: source: ...]` text block per image, so requiring a single
 *  block missed every multi-image turn. A turn qualifies only when it is all text
 *  and every block is a marker, so a real prompt is never mistaken for one. */
export function imageSourcePathsFromMessage(message: NativeChatMessage): string[] {
  if (message.role !== 'user' || message.blocks.length === 0) {
    return []
  }
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

/** The text the agent reads: each composer chip becomes `[Image #N]`, N being its image's place
 *  among the images sent with it, as the Claude and Codex TUIs number them. A chip whose image is
 *  not sent is dropped. */
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

/** The inverse, for a sent message put back in the composer: `[Image #k]` becomes a chip for its
 *  k-th image. A number past its images is left as typed. */
export function promptMarkersToImageReferences(text: string, imageIds: readonly string[]): string {
  return replaceSentImagePromptMarkers(text, (number, marker) => {
    const attachmentId = imageIds[number - 1]
    return attachmentId === undefined ? marker : imageReferenceToken(attachmentId)
  })
}

/** A structured chat's sent text without the `[Image #k]` markers its send added for its
 *  `imageCount` images. A number past its images is left as typed. */
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
  return message.blocks.some((block) => isTextBlock(block) && IMAGE_PROMPT_MARKER.test(block.text))
}

/** Claude records image paths as source turns followed by a prompt carrying
 *  image markers. Merge the whole run back into one native user turn. */
export function normalizeImageTranscriptMessages(
  messages: readonly NativeChatMessage[]
): NativeChatMessage[] {
  let normalized: NativeChatMessage[] | null = null
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!
    if (message.role !== 'user') {
      normalized?.push(message)
      continue
    }
    const messageImagePaths = imageSourcePathsFromMessage(message)
    if (messageImagePaths.length > 0) {
      normalized ??= messages.slice(0, index)
      const imagePaths = [...messageImagePaths]
      let nextIndex = index + 1
      while (nextIndex < messages.length) {
        const candidate = messages[nextIndex]!
        const candidatePaths = imageSourcePathsFromMessage(candidate)
        if (
          candidate.role !== 'user' ||
          candidate.source !== message.source ||
          candidatePaths.length === 0
        ) {
          break
        }
        imagePaths.push(...candidatePaths)
        nextIndex += 1
      }
      const prompt = messages[nextIndex]
      if (
        prompt?.role === 'user' &&
        prompt.source === message.source &&
        hasImagePromptMarker(prompt)
      ) {
        normalized.push({
          ...prompt,
          blocks: [
            ...imagePaths.map((path) => ({ type: 'image-ref' as const, path })),
            ...stripImagePromptMarkersFromTextBlocks(prompt.blocks)
          ]
        })
        index = nextIndex
        continue
      }
      // Only THIS turn's paths: `imagePaths` also holds the following source turns the
      // fold scan looked at, and without a prompt to fold into they stay separate turns.
      normalized.push({
        ...message,
        blocks: messageImagePaths.map((path) => ({ type: 'image-ref' as const, path }))
      })
      continue
    }
    const blocks = stripImagePromptMarkersFromTextBlocks(message.blocks)
    if (blocks === message.blocks) {
      normalized?.push(message)
    } else {
      normalized ??= messages.slice(0, index)
      normalized.push({ ...message, blocks })
    }
  }
  return normalized ?? (messages as NativeChatMessage[])
}
