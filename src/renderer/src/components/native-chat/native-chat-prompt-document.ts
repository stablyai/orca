import { NativeChatSkillPill } from './NativeChatSkillPill'
import { ReactNodeViewRenderer, Node, type JSONContent } from '@tiptap/react'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'

export const NativeChatSkill = Node.create({
  name: 'nativeChatSkill',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addNodeView: () => ReactNodeViewRenderer(NativeChatSkillPill),
  addAttributes: () => ({ token: { default: '' } }),
  renderText: ({ node }) => node.attrs.token,
  renderHTML: ({ node }) => [
    'span',
    {
      'data-native-chat-skill': node.attrs.token,
      contenteditable: 'false',
      class:
        'inline-flex items-center gap-1 rounded-full border border-border bg-muted px-1.5 text-sm font-medium text-muted-foreground align-baseline select-none'
    },
    ['span', { 'aria-hidden': 'true' }, 'ϟ'],
    ['span', {}, String(node.attrs.token).slice(1)]
  ]
})

export function promptTextContent(text: string): JSONContent {
  return {
    type: 'doc',
    content: text.split('\n').map((line) => ({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line }] : []
    }))
  }
}

/** Each boundary maps a plain-text caret to a document position, including atomic skills. */
export function promptTextMap(doc: ProseMirrorNode): { text: string; positions: number[] } {
  let text = ''
  const positions = [1]
  doc.forEach((block, blockOffset, index) => {
    if (index > 0) {
      text += '\n'
      positions.push(blockOffset + 1)
    }
    block.forEach((node, offset) => {
      const start = blockOffset + 1 + offset
      const value = node.isText
        ? node.text!
        : node.type.name === 'hardBreak'
          ? '\n'
          : String(node.attrs.token ?? '')
      for (let i = 0; i < value.length; i++) {
        text += value[i]
        positions.push(
          node.isText ? start + i + 1 : i === value.length - 1 ? start + node.nodeSize : start
        )
      }
    })
  })
  return { text, positions }
}

export function promptTextOffset(doc: ProseMirrorNode, position: number): number {
  const { positions } = promptTextMap(doc)
  const index = positions.findIndex((candidate) => candidate >= position)
  return index === -1 ? positions.length - 1 : index
}
