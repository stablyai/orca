import type { JSONContent } from '@tiptap/react'
import { splitImageReferences } from '../../../../shared/native-chat-image-reference'

export const IMAGE_REFERENCE_NODE = 'nativeChatImageReference'

/** Every path from text to a document goes through here, so each image token becomes its chip. */
export function promptTextContent(text: string): JSONContent {
  return {
    type: 'doc',
    content: text.split('\n').map((line) => ({
      type: 'paragraph',
      content: splitImageReferences(line).map((part) =>
        typeof part === 'string'
          ? { type: 'text', text: part }
          : { type: IMAGE_REFERENCE_NODE, attrs: { attachmentId: part.attachmentId } }
      )
    }))
  }
}

/** The document without the chips of one image. */
export function withoutImageReferenceNodes(
  document: JSONContent,
  attachmentId: string
): JSONContent {
  return document.content
    ? {
        ...document,
        content: document.content
          .filter(
            (node) =>
              node.type !== IMAGE_REFERENCE_NODE || node.attrs?.attachmentId !== attachmentId
          )
          .map((node) => withoutImageReferenceNodes(node, attachmentId))
      }
    : document
}

/** Applies an appended text change without replacing existing picked nodes. */
export function appendPromptDocumentText(
  document: JSONContent | undefined,
  before: string,
  after: string
): JSONContent | undefined {
  if (!document || before === after) {
    return document
  }
  const kept = before.trimEnd()
  if (kept === '') {
    return promptTextContent(after)
  }
  const blocks = [...(document.content ?? [])]
  while (blocks.length > 0) {
    const block = blocks.pop()
    const content = [...(block?.content ?? [])]
    while (content.length > 0) {
      const node = content.at(-1)
      if (node?.type === 'hardBreak') {
        content.pop()
      } else if (node?.type === 'text') {
        const text = node.text?.trimEnd() ?? ''
        if (text === '') {
          content.pop()
        } else {
          content[content.length - 1] = { ...node, text }
          break
        }
      } else {
        break
      }
    }
    if (content.length > 0 && block) {
      const [first, ...rest] = promptTextContent(after.slice(kept.length)).content ?? []
      return {
        ...document,
        content: [
          ...blocks,
          { ...block, content: [...content, ...(first?.content ?? [])] },
          ...rest
        ]
      }
    }
  }
  return promptTextContent(after)
}
