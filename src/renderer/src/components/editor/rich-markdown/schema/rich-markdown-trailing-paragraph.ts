import type { Editor } from '@tiptap/core'
import { TrailingNode } from '@tiptap/extensions'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'

const trailingParagraph = new PluginKey<ProseMirrorNode | null>('richMarkdownTrailingParagraph')

// The click target below a final quote/list is UI scaffolding until the user edits it.
export const RichMarkdownTrailingParagraph = TrailingNode.extend({
  addProseMirrorPlugins() {
    const plugins = (this.parent?.() ?? []).map((plugin) => {
      const append = plugin.spec.appendTransaction
      if (!append) {
        return plugin
      }
      return new Plugin({
        ...plugin.spec,
        appendTransaction(transactions, oldState, state) {
          const transaction = append.call(plugin, transactions, oldState, state)
          if (transaction) {
            transaction.setMeta(trailingParagraph, transaction.doc.lastChild)
          }
          return transaction
        }
      })
    })
    return [
      ...plugins,
      new Plugin<ProseMirrorNode | null>({
        key: trailingParagraph,
        state: {
          init: () => null,
          apply(transaction, previous, oldState) {
            const inserted: unknown = transaction.getMeta(trailingParagraph)
            if (inserted === transaction.doc.lastChild && transaction.doc.lastChild) {
              return transaction.doc.lastChild
            }
            if (!previous || !transaction.docChanged) {
              return previous
            }
            let start = oldState.doc.content.size - previous.nodeSize
            let touched = false
            for (const map of transaction.mapping.maps) {
              map.forEach((from, to) => {
                if (from <= start + previous.nodeSize && to > start) {
                  touched = true
                }
              })
              start = map.map(start, 1)
            }
            return !touched && transaction.doc.lastChild === previous ? previous : null
          }
        }
      })
    ]
  }
})

export function getRichMarkdownSerializationDocument(editor: Editor): ProseMirrorNode {
  const document = editor.state.doc
  const synthetic = trailingParagraph.getState(editor.state)
  return synthetic && document.lastChild === synthetic
    ? document.copy(document.content.cut(0, document.content.size - synthetic.nodeSize))
    : document
}
