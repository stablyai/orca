import { readAgentImageSourceContext } from '../../input/composer/agent-image-paste'
import { unwrapClaudePastedContent } from '../../../agent-hook-listener/providers/claude/transcripts/claude-pasted-content'
import { isImageRefBlock, isTextBlock, type NativeChatMessage } from '../../native-chat-types'
import { normalizeNativeChatUserText } from '../images/native-chat-image-transcript-markers'

export function pendingImagePrefixes(
  original: readonly string[] = [],
  delivered: readonly string[] = []
): string[] {
  return [original, delivered].flatMap((candidate) => {
    const normalized = candidate.filter(Boolean).map(normalizeNativeChatUserText)
    return [normalized.join(' '), normalized.join('')]
  })
}

const imageDeliveryRows = new WeakMap<
  NativeChatMessage['blocks'],
  {
    text: string
    paths: string[]
    original: string[]
    prefixes: string[]
  }
>()

export function imageDeliveryRow(message: NativeChatMessage) {
  const cached = imageDeliveryRows.get(message.blocks)
  if (cached) {
    return cached
  }
  const context = readAgentImageSourceContext(
    message.blocks
      .filter(isTextBlock)
      .map((block) => unwrapClaudePastedContent(block.text))
      .join(' ')
  )
  const sources = new Map(context.delivered.map((path, index) => [path, context.original[index]]))
  const paths = message.blocks
    .filter(isImageRefBlock)
    .map((block) => block.path)
    .filter((path): path is string => Boolean(path))
    .map((path) => sources.get(path) ?? path)
  const row = {
    text: normalizeNativeChatUserText(context.text),
    paths,
    original: context.original,
    prefixes: context.original.length
      ? pendingImagePrefixes(context.original, context.delivered)
      : []
  }
  imageDeliveryRows.set(message.blocks, row)
  return row
}
