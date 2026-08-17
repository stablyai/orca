import {
  isImageRefBlock,
  isTextBlock,
  type NativeChatBlock,
  type NativeChatMessage
} from './native-chat-types'

const IMAGE_SOURCE_MARKER = /^\[Image:\s*source:\s*(.+?)\]\s*$/
const IMAGE_PROMPT_MARKER = /\[Image #\d+\]/
const IMAGE_PROMPT_MARKERS = /\[Image #\d+\]/g
const IMAGE_PROMPT_MARKER_AT_START = /^[^\S\r\n]*\[Image #\d+\]/
const IMAGE_PROMPT_MARKER_AT_END = /\[Image #\d+\][^\S\r\n]*$/
const HORIZONTAL_WHITESPACE_START = /^[^\S\r\n]+/
const HORIZONTAL_WHITESPACE_END = /[^\S\r\n]+$/

function soleText(message: NativeChatMessage): string | null {
  return message.blocks.length === 1 && isTextBlock(message.blocks[0])
    ? message.blocks[0].text
    : null
}

export function imageSourcePathFromText(text: string): string | null {
  return text.match(IMAGE_SOURCE_MARKER)?.[1]?.trim() ?? null
}

export function isImageSourceUserTurn(message: NativeChatMessage): boolean {
  return message.role === 'user' && imageSourcePathFromText(soleText(message) ?? '') !== null
}

function countMarkers(text: string): number {
  return text.match(IMAGE_PROMPT_MARKERS)?.length ?? 0
}

/** Strips the first `limit` markers in document order; the rest are the user's
 *  own words, so they stay verbatim. */
function stripImagePromptMarkersUpTo(text: string, limit: number): string {
  if (limit <= 0) {
    return text
  }
  let used = 0
  const stripped = text.replace(IMAGE_PROMPT_MARKERS, (match) => {
    if (used >= limit) {
      return match
    }
    used += 1
    return ''
  })
  if (stripped === text) {
    return text
  }
  let result = IMAGE_PROMPT_MARKER_AT_START.test(text)
    ? stripped.replace(HORIZONTAL_WHITESPACE_START, '')
    : stripped
  // Why: a trailing marker left in place still owns the whitespace before it.
  if (used === countMarkers(text) && IMAGE_PROMPT_MARKER_AT_END.test(text)) {
    result = result.replace(HORIZONTAL_WHITESPACE_END, '')
  }
  return result
}

export function stripImagePromptMarker(text: string): string {
  return stripImagePromptMarkersUpTo(text, Number.POSITIVE_INFINITY)
}

export function normalizeNativeChatUserText(text: string): string {
  return stripImagePromptMarker(text).trim().replace(/\s+/g, ' ')
}

function normalizeLiteralNativeChatUserText(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

export function nativeChatUserTextMatchText(text: string, hasImages: boolean): string {
  return hasImages ? normalizeNativeChatUserText(text) : normalizeLiteralNativeChatUserText(text)
}

function joinedUserText(message: NativeChatMessage): string {
  return message.blocks
    .filter(isTextBlock)
    .map((block) => block.text)
    .join(' ')
}

export function normalizedNativeChatUserMessageText(message: NativeChatMessage): string | null {
  if (message.role !== 'user') {
    return null
  }
  return normalizeNativeChatUserText(joinedUserText(message)) || null
}

/** The text an optimistic echo matches a landed turn on. Keeps literal marker
 *  text keyable so the pending path and the render path agree about which
 *  `[Image #n]` runs are the user's own words. */
export function nativeChatUserMessageMatchText(message: NativeChatMessage): string | null {
  if (message.role !== 'user') {
    return null
  }
  const joined = joinedUserText(message)
  return nativeChatUserTextMatchText(joined, message.blocks.some(isImageRefBlock)) || null
}

/** `limit` is the number of images the run actually carried. Only that many
 *  markers can be placeholders; the rest are text the user typed. */
export function stripImagePromptMarkersFromTextBlocks(
  blocks: readonly NativeChatBlock[],
  limit: number
): NativeChatBlock[] {
  let sawText = false
  let remaining = limit
  let next: NativeChatBlock[] | null = null
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!
    if (!isTextBlock(block)) {
      next?.push(block)
      continue
    }
    const isFirstText = !sawText
    sawText = true
    const text = stripImagePromptMarkersUpTo(block.text, remaining)
    remaining -= Math.min(remaining, countMarkers(block.text))
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

function removeEmptyFirstTextBlock(blocks: readonly NativeChatBlock[]): NativeChatBlock[] {
  const index = blocks.findIndex(isTextBlock)
  const block = blocks[index]
  if (index === -1 || !block || !isTextBlock(block) || block.text.trim()) {
    return blocks as NativeChatBlock[]
  }
  return [...blocks.slice(0, index), ...blocks.slice(index + 1)]
}

export function hasImagePromptMarker(message: NativeChatMessage): boolean {
  return message.blocks.some((block) => isTextBlock(block) && IMAGE_PROMPT_MARKER.test(block.text))
}

/** Markers carried by a turn. One marker vouches for one image, so a send of N
 *  images is only echoed by a turn bearing N of them. */
export function countImagePromptMarkers(message: NativeChatMessage): number {
  return message.blocks.reduce(
    (count, block) =>
      count + (isTextBlock(block) ? (block.text.match(IMAGE_PROMPT_MARKERS)?.length ?? 0) : 0),
    0
  )
}

/**
 * How many image-carrying sends a row can vouch for.
 *
 * Structure wins wherever it exists; markers are the fallback for a host that
 * echoes an image send as bare `[Image #n]` with no `[Image: source: …]` turn,
 * never a top-up on a row already showing its photos. Taking the larger of the
 * two used to be equivalent, because every marker was stripped from every turn —
 * but the strip is now bounded to the size of the run it anchors to, so a row can
 * legitimately keep markers the user typed. Counting those as photos let a row
 * rendering one image retire a send that carried two, and `prunePendingSends`
 * then dropped that send from the bounded cache with the user's photos in it.
 *
 * Under-counting only costs a duplicate bubble; over-counting loses the photo.
 * That is the same trade `nativeChatUserTextRow` already makes on the glue arm.
 */
export function nativeChatUserMessageImageEvidenceCount(message: NativeChatMessage): number {
  if (message.role !== 'user') {
    return 0
  }
  const imageRefCount = message.blocks.filter(isImageRefBlock).length
  return imageRefCount > 0 ? imageRefCount : countImagePromptMarkers(message)
}

export type NormalizeImageTranscriptOptions = {
  /**
   * Id of the oldest row of the paginated transcript window, and only when older
   * history exists above it. That row — alone — can sit *inside* an image run
   * whose `[Image: source: …]` turns were trimmed away by the hard count slice.
   * Its markers are then un-anchorable evidence rather than proof the user typed
   * them, and stripping is the safer read: leaving them shows agent-internal
   * markup in a message the user already sent, and the run's real image count is
   * no longer knowable, so the count bound cannot apply either.
   *
   * Nowhere else is ambiguous — a marker turn further down would have its source
   * run visible above it, so its absence there is real evidence.
   *
   * Deliberately an id, not a positional flag. Callers hand this function lists
   * that have already been merged across sources and re-sorted, where index 0 is
   * whichever row sorts first — a scrape or hook row that was never paginated, or
   * for a transcript that carries no timestamps (some agents), the row with the
   * lexicographically smallest id. Neither is the window head.
   */
  windowHeadMessageId?: string
}

/** Claude records image paths as source turns followed by a prompt carrying
 *  image markers. Merge the whole run back into one native user turn. */
export function normalizeImageTranscriptMessages(
  messages: readonly NativeChatMessage[],
  options?: NormalizeImageTranscriptOptions
): NativeChatMessage[] {
  const windowHeadMessageId = options?.windowHeadMessageId
  // Why: absent option means there is no window head at all, so the rule must not
  // fire. Comparing ids alone would let a row whose own id is missing — the remote
  // read casts host frames without validating per-message fields — satisfy
  // `message.id === undefined` and strip a marker the user typed.
  const isWindowHead = (candidate: NativeChatMessage): boolean =>
    windowHeadMessageId !== undefined && candidate.id === windowHeadMessageId
  let normalized: NativeChatMessage[] | null = null
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!
    if (message.role !== 'user') {
      normalized?.push(message)
      continue
    }
    const imagePath = imageSourcePathFromText(soleText(message) ?? '')
    if (imagePath) {
      normalized ??= messages.slice(0, index)
      const imagePaths = [imagePath]
      let nextIndex = index + 1
      while (nextIndex < messages.length) {
        const candidate = messages[nextIndex]!
        const candidatePath = imageSourcePathFromText(soleText(candidate) ?? '')
        if (candidate.role !== 'user' || candidate.source !== message.source || !candidatePath) {
          break
        }
        imagePaths.push(candidatePath)
        nextIndex += 1
      }
      const prompt = messages[nextIndex]
      if (
        prompt?.role === 'user' &&
        prompt.source === message.source &&
        hasImagePromptMarker(prompt)
      ) {
        // Why: a run touching the window head may have lost earlier source turns,
        // so the visible image count is a floor, not the run's real size.
        const limit = isWindowHead(message) ? Number.POSITIVE_INFINITY : imagePaths.length
        normalized.push({
          ...prompt,
          blocks: [
            ...imagePaths.map((path) => ({ type: 'image-ref' as const, path })),
            ...stripImagePromptMarkersFromTextBlocks(prompt.blocks, limit)
          ]
        })
        index = nextIndex
        continue
      }
      normalized.push({
        ...message,
        blocks: [{ type: 'image-ref', path: imagePath }]
      })
      continue
    }
    // Why: the whole source run above the head can be trimmed away, leaving the
    // prompt alone at index 0 with markers no anchor can vouch for.
    const blocks =
      isWindowHead(message) && hasImagePromptMarker(message)
        ? stripImagePromptMarkersFromTextBlocks(message.blocks, Number.POSITIVE_INFINITY)
        : removeEmptyFirstTextBlock(message.blocks)
    if (blocks === message.blocks) {
      normalized?.push(message)
    } else {
      normalized ??= messages.slice(0, index)
      normalized.push({ ...message, blocks })
    }
  }
  return normalized ?? (messages as NativeChatMessage[])
}
