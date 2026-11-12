import { NATIVE_CHAT_QUOTED_FILE_REFERENCE } from '../../agent-image-paste'
import { imageReferenceToken, replaceImageReferences } from '../native-chat-image-reference'
import { isTextBlock, type NativeChatBlock, type NativeChatMessage } from '../native-chat-types'

export const IMAGE_PROMPT_MARKER = /\[Image #\d+\]/
const IMAGE_PROMPT_MARKERS = /\[Image #\d+\]/g
// Quoted file references and markdown code spans/fences are matched whole so literal markers stay as typed.
const SENT_MARKER_OR_PROTECTED_TOKEN = new RegExp(
  `(\`+)|(${NATIVE_CHAT_QUOTED_FILE_REFERENCE.source})|\\[Image #(\\d+)\\]`,
  'g'
)
const BACKTICKS = /`+/g
const BLANK_LINE_BREAK = /\r?\n[ \t]*\r?\n/
const FENCE_OPEN = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
const IMAGE_PROMPT_MARKER_AT_START = /^[^\S\r\n]*\[Image #\d+\]/
const IMAGE_PROMPT_MARKER_AT_END = /\[Image #\d+\][^\S\r\n]*$/
const HORIZONTAL_WHITESPACE_START = /^[^\S\r\n]+/
const HORIZONTAL_WHITESPACE_END = /[^\S\r\n]+$/
const EDGE_BLANK_LINES = /^(?:[ \t]*\r?\n)+|(?:\r?\n[ \t]*)+$/g

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

function findClosingBackticks(text: string, from: number, length: number): number {
  BACKTICKS.lastIndex = from
  for (let match = BACKTICKS.exec(text); match !== null; match = BACKTICKS.exec(text)) {
    if (BLANK_LINE_BREAK.test(text.slice(from, match.index))) {
      return -1
    }
    if (match[0].length === length) {
      return match.index + length
    }
  }
  return -1
}

function replaceMarkersOutsideInlineCode(
  text: string,
  replace: (number: number, marker: string) => string
): string {
  let out = ''
  let last = 0
  SENT_MARKER_OR_PROTECTED_TOKEN.lastIndex = 0
  for (
    let match = SENT_MARKER_OR_PROTECTED_TOKEN.exec(text);
    match !== null;
    match = SENT_MARKER_OR_PROTECTED_TOKEN.exec(text)
  ) {
    const [token, ticks, fileReference, number] = match
    if (ticks !== undefined) {
      const closeEnd = findClosingBackticks(text, match.index + ticks.length, ticks.length)
      if (closeEnd !== -1) {
        SENT_MARKER_OR_PROTECTED_TOKEN.lastIndex = closeEnd
      }
      continue
    }
    if (fileReference !== undefined || number === undefined) {
      continue
    }
    out += text.slice(last, match.index) + replace(Number(number), token)
    last = match.index + token.length
  }
  return last === 0 ? text : out + text.slice(last)
}

function replaceSentImagePromptMarkers(
  text: string,
  replace: (number: number, marker: string) => string
): string {
  if (!IMAGE_PROMPT_MARKER.test(text)) {
    return text
  }
  const out: string[] = []
  let proseLines: string[] = []
  let fence: string | null = null
  const flushProse = (): void => {
    if (proseLines.length > 0) {
      out.push(replaceMarkersOutsideInlineCode(proseLines.join('\n'), replace))
      proseLines = []
    }
  }
  for (const line of text.split('\n')) {
    const bare = line.replace(/\r$/, '')
    if (fence !== null) {
      out.push(line)
      const closer = FENCE_CLOSE.exec(bare)?.[1]
      if (closer && closer[0] === fence[0] && closer.length >= fence.length) {
        fence = null
      }
      continue
    }
    const opener = FENCE_OPEN.exec(bare)?.[1]
    if (opener) {
      flushProse()
      fence = opener
      out.push(line)
      continue
    }
    proseLines.push(line)
  }
  flushProse()
  return out.join('\n')
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

// Keyed by block array so downstream row-content caches keep hitting across renders.
const withoutSentMarkers = new WeakMap<readonly NativeChatBlock[], NativeChatBlock[]>()

/** A user message's blocks without the `[Image #k]` markers its send wrote; its images already show above the words. */
export function withoutSentImagePromptMarkers(
  message: Pick<NativeChatMessage, 'role' | 'blocks'>
): NativeChatBlock[] {
  if (message.role !== 'user') {
    return message.blocks
  }
  const cached = withoutSentMarkers.get(message.blocks)
  if (cached) {
    return cached
  }
  const imageCount = message.blocks.filter((block) => block.type === 'image-ref').length
  let changed = false
  const blocks = message.blocks.flatMap((block): NativeChatBlock[] => {
    if (!isTextBlock(block)) {
      return [block]
    }
    const stripped = stripSentImagePromptMarkers(block.text, imageCount)
    if (stripped === block.text) {
      return [block]
    }
    changed = true
    // A marker alone on the first or last line must not leave a blank line in copied text.
    const text = stripped.replace(EDGE_BLANK_LINES, '')
    return text.trim() ? [{ ...block, text }] : []
  })
  const result = changed ? blocks : message.blocks
  withoutSentMarkers.set(message.blocks, result)
  return result
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
