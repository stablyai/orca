import { isTextBlock, type NativeChatBlock, type NativeChatMessage } from './native-chat-types'

const IMAGE_SOURCE_MARKER = /^\[Image:\s*source:\s*(.+?)\]\s*$/
const IMAGE_PROMPT_MARKER = /^\[Image #\d+\]\s*/

function soleText(message: NativeChatMessage): string | null {
  return message.blocks.length === 1 && isTextBlock(message.blocks[0])
    ? message.blocks[0].text
    : null
}

export function imageSourcePathFromText(text: string): string | null {
  return text.match(IMAGE_SOURCE_MARKER)?.[1]?.trim() ?? null
}

export function stripImagePromptMarker(text: string): string {
  return text.replace(IMAGE_PROMPT_MARKER, '')
}

function stripFirstImagePromptMarker(blocks: readonly NativeChatBlock[]): NativeChatBlock[] {
  let stripped = false
  const next: NativeChatBlock[] = []
  for (const block of blocks) {
    if (!stripped && isTextBlock(block)) {
      stripped = true
      const text = stripImagePromptMarker(block.text)
      if (text.trim().length > 0) {
        next.push({ ...block, text })
      }
      continue
    }
    next.push(block)
  }
  return next
}

function imagePromptMarkerStartsMessage(message: NativeChatMessage): boolean {
  const firstText = message.blocks.find(isTextBlock)
  return firstText ? IMAGE_PROMPT_MARKER.test(firstText.text) : false
}

/** Claude records an attached image as two user transcript turns:
 *  `[Image: source: /path]` and then `[Image #1] prompt`. Merge them back into
 *  one native turn so the UI keeps the same chip+text shape as the optimistic
 *  send and does not show raw TUI marker text after a view remount. */
export function normalizeImageTranscriptMessages(
  messages: readonly NativeChatMessage[]
): NativeChatMessage[] {
  const normalized: NativeChatMessage[] = []
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!
    if (message.role !== 'user') {
      normalized.push(message)
      continue
    }
    const firstImagePath = imageSourcePathFromText(soleText(message) ?? '')
    if (firstImagePath) {
      const imageMessages = [message]
      const imagePaths = [firstImagePath]
      let lastImageIndex = index
      while (lastImageIndex + 1 < messages.length) {
        const candidate = messages[lastImageIndex + 1]!
        const candidatePath =
          candidate.role === 'user' && candidate.source === message.source
            ? imageSourcePathFromText(soleText(candidate) ?? '')
            : null
        if (!candidatePath) {
          break
        }
        imageMessages.push(candidate)
        imagePaths.push(candidatePath)
        lastImageIndex += 1
      }
      const prompt = messages[lastImageIndex + 1]
      if (
        prompt?.role === 'user' &&
        prompt.source === message.source &&
        imagePromptMarkerStartsMessage(prompt)
      ) {
        normalized.push({
          ...prompt,
          blocks: [
            ...imagePaths.map((path) => ({ type: 'image-ref' as const, path })),
            ...stripFirstImagePromptMarker(prompt.blocks)
          ]
        })
        index = lastImageIndex + 1
        continue
      }
      normalized.push(
        ...imageMessages.map((imageMessage, imageIndex) => ({
          ...imageMessage,
          blocks: [{ type: 'image-ref' as const, path: imagePaths[imageIndex]! }]
        }))
      )
      index = lastImageIndex
      continue
    }
    normalized.push({
      ...message,
      blocks: stripFirstImagePromptMarker(message.blocks)
    })
  }
  return normalized
}
