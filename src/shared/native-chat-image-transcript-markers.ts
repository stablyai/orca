import { isTextBlock, type NativeChatBlock, type NativeChatMessage } from './native-chat-types'

const IMAGE_SOURCE_MARKER = /^\[Image:\s*source:\s*(.+?)\]\s*$/
const IMAGE_PROMPT_MARKERS = /^(?:\[Image #\d+\]\s*)+/

function soleText(message: NativeChatMessage): string | null {
  return message.blocks.length === 1 && isTextBlock(message.blocks[0])
    ? message.blocks[0].text
    : null
}

export function imageSourcePathFromText(text: string): string | null {
  return text.match(IMAGE_SOURCE_MARKER)?.[1]?.trim() ?? null
}

export function stripImagePromptMarker(text: string): string {
  return text.replace(IMAGE_PROMPT_MARKERS, '')
}

function stripImagePromptMarkersFromFirstText(
  blocks: readonly NativeChatBlock[]
): NativeChatBlock[] {
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
  return firstText ? IMAGE_PROMPT_MARKERS.test(firstText.text) : false
}

/** Claude records image paths as source turns followed by one marker-prefixed
 *  prompt. Merge the whole run back into one native user turn. */
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
    const imagePath = imageSourcePathFromText(soleText(message) ?? '')
    if (imagePath) {
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
        imagePromptMarkerStartsMessage(prompt)
      ) {
        normalized.push({
          ...prompt,
          blocks: [
            ...imagePaths.map((path) => ({ type: 'image-ref' as const, path })),
            ...stripImagePromptMarkersFromFirstText(prompt.blocks)
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
    normalized.push({
      ...message,
      blocks: stripImagePromptMarkersFromFirstText(message.blocks)
    })
  }
  return normalized
}
