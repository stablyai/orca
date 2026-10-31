import type { JSONContent } from '@tiptap/react'
import {
  imageReferenceToken,
  splitImageReferences
} from '../../../../shared/native-chat/native-chat-image-reference'
import { NATIVE_CHAT_PASTED_TEXT_TOKEN } from './native-chat-pasted-text-reference'

export const IMAGE_REFERENCE_NODE = 'nativeChatImageReference'
export const FILE_REFERENCE_NODE = 'nativeChatFileReference'

/** All text-to-document paths must reconstruct image chips and pending-paste pills. */
export function promptTextContent(text: string): JSONContent {
  return {
    type: 'doc',
    content: text.split('\n').map((line) => ({
      type: 'paragraph',
      content: splitImageReferences(line).flatMap((part) =>
        typeof part === 'string'
          ? part
              .split(NATIVE_CHAT_PASTED_TEXT_TOKEN)
              .flatMap((piece, index): JSONContent[] =>
                piece === ''
                  ? []
                  : index % 2 === 1
                    ? [{ type: FILE_REFERENCE_NODE, attrs: { token: piece, path: '' } }]
                    : [{ type: 'text', text: piece }]
              )
          : [{ type: IMAGE_REFERENCE_NODE, attrs: { attachmentId: part.attachmentId } }]
      )
    }))
  }
}

/** The document side of withoutImageReference: each chip goes with one space after it. */
export function withoutImageReferenceNodes(
  document: JSONContent,
  attachmentId: string
): JSONContent {
  const isChip = (node: JSONContent | undefined): boolean =>
    node?.type === IMAGE_REFERENCE_NODE && node.attrs?.attachmentId === attachmentId
  return document.content
    ? {
        ...document,
        content: document.content.flatMap((node, index, nodes) => {
          if (isChip(node)) {
            return []
          }
          if (isChip(nodes[index - 1]) && node.type === 'text' && node.text?.startsWith(' ')) {
            const text = node.text.slice(1)
            return text ? [{ ...node, text }] : []
          }
          return [withoutImageReferenceNodes(node, attachmentId)]
        })
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

/** Slice serialized prompt offsets while retaining selected nodes inside the range. */
export function slicePromptDocument(document: JSONContent, from: number, to: number): JSONContent {
  let offset = 0
  const blocks: JSONContent[] = []
  for (const [index, block] of (document.content ?? []).entries()) {
    if (index > 0) {
      offset++
    }
    const start = offset
    const content: JSONContent[] = []
    for (const node of block.content ?? []) {
      const value =
        node.type === IMAGE_REFERENCE_NODE
          ? imageReferenceToken(String(node.attrs?.attachmentId))
          : node.type === 'hardBreak'
            ? '\n'
            : (node.text ?? String(node.attrs?.token ?? ''))
      const end = offset + value.length
      if (end > from && offset < to) {
        content.push(
          node.type === 'text'
            ? {
                ...node,
                text: value.slice(Math.max(0, from - offset), Math.min(value.length, to - offset))
              }
            : node
        )
      }
      offset = end
    }
    if (offset >= from && start <= to) {
      blocks.push({ ...block, content })
    }
  }
  return { ...document, content: blocks.length ? blocks : [{ type: 'paragraph' }] }
}
