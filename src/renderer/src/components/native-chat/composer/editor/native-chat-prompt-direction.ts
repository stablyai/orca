import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { dominantTextDirection } from '@/lib/text-direction'

function paragraphDirections(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) {
      return true
    }
    const dir = dominantTextDirection(node.textContent)
    if (dir) {
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { dir }))
    }
    return false
  })
  return DecorationSet.create(doc, decorations)
}

/** Each composer line reads in the direction most of its words do, as sent messages render. */
export const NativeChatPromptDirection = Extension.create({
  name: 'nativeChatPromptDirection',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: { decorations: (state) => paragraphDirections(state.doc) }
      })
    ]
  }
})
