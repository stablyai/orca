import type { NativeChatBlock } from './native-chat-types'

export const NATIVE_CHAT_GENERATED_IMAGE_PRESENTATION = 'generated-image'
/** An image view or a generation status without a preview: work the agent did, not words it said. */
export const NATIVE_CHAT_IMAGE_OPERATION_PRESENTATION = 'image-operation'

/** Record provenance while the producer still knows this is output, rather than an image it read. */
export function generatedImageBlocks(blocks: NativeChatBlock[]): NativeChatBlock[] {
  if (!blocks.some((block) => block.type === 'image-ref')) {
    return blocks
  }
  let marked = false
  const result = blocks.map((block) => {
    if (block.type !== 'text') {
      return block
    }
    marked = true
    return { ...block, presentation: NATIVE_CHAT_GENERATED_IMAGE_PRESENTATION }
  })
  return marked
    ? result
    : [
        { type: 'text', text: '', presentation: NATIVE_CHAT_GENERATED_IMAGE_PRESENTATION },
        ...blocks
      ]
}

export function isGeneratedImageOperation(block: NativeChatBlock): boolean {
  return block.type === 'text' && block.presentation === NATIVE_CHAT_GENERATED_IMAGE_PRESENTATION
}

export function isImageOperation(block: NativeChatBlock): boolean {
  return (
    isGeneratedImageOperation(block) ||
    (block.type === 'text' && block.presentation === NATIVE_CHAT_IMAGE_OPERATION_PRESENTATION)
  )
}
