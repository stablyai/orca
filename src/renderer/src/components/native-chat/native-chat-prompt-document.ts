import { NativeChatFileReferencePill } from './NativeChatFileReferencePill'
import { NativeChatSkillPill, skillLabel } from './NativeChatSkillPill'
import { NativeChatImageReferencePill } from './NativeChatImageReferencePill'
import { formatNativeChatFileReference } from '../../../../shared/agent-image-paste'
import { imageReferenceToken } from '../../../../shared/native-chat-image-reference'
import { FILE_REFERENCE_NODE, IMAGE_REFERENCE_NODE } from './native-chat-prompt-document-text'
import { ReactNodeViewRenderer, Node, type JSONContent } from '@tiptap/react'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { AgentJournalSkillRef } from '../../../../shared/agent-session-journal-types'
export { promptTextContent } from './native-chat-prompt-document-text'

export const NativeChatSkill = Node.create({
  name: 'nativeChatSkill',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addNodeView: () => ReactNodeViewRenderer(NativeChatSkillPill),
  // `path`: the file the agent selects the skill by, when it reported one; the text stays the token.
  addAttributes: () => ({ token: { default: '' }, path: { default: '' } }),
  renderText: ({ node }) => node.attrs.token,
  renderHTML: ({ node }) => [
    'span',
    {
      'data-native-chat-skill': node.attrs.token,
      contenteditable: 'false',
      class:
        'inline-flex items-center gap-1 rounded-full border border-border bg-muted px-1.5 text-xs font-medium text-muted-foreground align-baseline select-none'
    },
    ['span', { 'aria-hidden': 'true' }, 'ϟ'],
    ['span', {}, skillLabel(String(node.attrs.token))]
  ]
})

/** A file attached by path. `token` is the reference the agent reads; the pill shows the filename. */
export const NativeChatFileReference = Node.create({
  name: FILE_REFERENCE_NODE,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addNodeView: () => ReactNodeViewRenderer(NativeChatFileReferencePill),
  addAttributes: () => ({ token: { default: '' }, path: { default: '' } }),
  renderText: ({ node }) => node.attrs.token,
  renderHTML: ({ node }) => ['span', { 'data-native-chat-file-reference': node.attrs.path }]
})

/** An attached image named at its place in the prompt; the thumbnail row gives its number. */
export const NativeChatImageReference = Node.create({
  name: IMAGE_REFERENCE_NODE,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addNodeView: () => ReactNodeViewRenderer(NativeChatImageReferencePill),
  addAttributes: () => ({ attachmentId: { default: '' } }),
  renderText: ({ node }) => imageReferenceToken(node.attrs.attachmentId),
  renderHTML: ({ node }) => [
    'span',
    { 'data-native-chat-image-reference': node.attrs.attachmentId }
  ]
})

/** The skills a draft picked from the menu with their files, as a send hands them to the agent. */
export function promptSkillRefs(document: JSONContent | undefined): AgentJournalSkillRef[] {
  if (!document) {
    return []
  }
  const token = document.attrs?.token
  const path = document.attrs?.path
  const own =
    document.type === NativeChatSkill.name &&
    typeof token === 'string' &&
    typeof path === 'string' &&
    token.length > 1 &&
    path.length > 0
      ? [{ name: token.slice(1), path }]
      : []
  return [...own, ...(document.content ?? []).flatMap((child) => promptSkillRefs(child))]
}

export function fileReferenceContent(path: string): JSONContent {
  return {
    type: NativeChatFileReference.name,
    attrs: { token: formatNativeChatFileReference(path), path }
  }
}

/** A pill reads as its token and a hard break as a newline, so the text is what the agent receives. */
export function promptLeafText(node: ProseMirrorNode): string {
  if (node.type.name === IMAGE_REFERENCE_NODE) {
    return imageReferenceToken(String(node.attrs.attachmentId))
  }
  return node.type.name === 'hardBreak' ? '\n' : String(node.attrs.token ?? '')
}

export function promptText(doc: ProseMirrorNode, from = 0, to = doc.content.size): string {
  return doc.textBetween(from, to, '\n', promptLeafText)
}

/** The plain-text caret for a document position. */
export function promptTextOffset(doc: ProseMirrorNode, position: number): number {
  const resolved = doc.resolve(position)
  // Paragraph node selections start outside the block; include its preceding newline.
  const to = resolved.parent === doc && resolved.nodeAfter?.isTextblock ? position + 1 : position
  return promptText(doc, 0, to).length
}

/** The document position for a plain-text caret; one inside a pill's token lands on the pill's
 *  `before` or `after` edge, and one past the end on the end. */
export function promptTextPosition(
  doc: ProseMirrorNode,
  offset: number,
  side: 'before' | 'after' = 'before'
): number {
  let remaining = offset
  let blockStart = 0
  let end = 1
  for (let index = 0; index < doc.childCount; index++) {
    const block = doc.child(index)
    if (index > 0) {
      if (remaining === 0) {
        return end
      }
      remaining--
    }
    let start = blockStart + 1
    for (let child = 0; child < block.childCount; child++) {
      if (remaining === 0) {
        return start
      }
      const node = block.child(child)
      const length = (node.text ?? promptLeafText(node)).length
      if (remaining < length) {
        return node.isText ? start + remaining : side === 'before' ? start : start + node.nodeSize
      }
      remaining -= length
      start += node.nodeSize
    }
    end = start
    blockStart += block.nodeSize
  }
  return end
}
