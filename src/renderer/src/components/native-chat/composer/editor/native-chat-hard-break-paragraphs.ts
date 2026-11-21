import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'

// Why: a hard break keeps lines in one paragraph, which Tiptap's line keys and triple-click treat as one line; Shift+Enter, Alt+Enter, dropped <br> and adopted drafts get one paragraph per line like paste.
export const NativeChatHardBreakParagraphs = Extension.create({
  name: 'nativeChatHardBreakParagraphs',
  addKeyboardShortcuts() {
    // Why: Alt/Option+Enter is the newline chord in Claude Code, Codex and most terminals.
    return { 'Alt-Enter': () => this.editor.commands.setHardBreak() }
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: (transactions, _oldState, state) => {
          if (!transactions.some((transaction) => transaction.docChanged)) {
            return null
          }
          const hardBreaks: number[] = []
          state.doc.descendants((node, pos) => {
            if (node.type.name === 'hardBreak') {
              hardBreaks.push(pos)
            }
          })
          if (hardBreaks.length === 0) {
            return null
          }
          const tr = state.tr
          for (const pos of hardBreaks.toReversed()) {
            tr.delete(pos, pos + 1).split(pos)
          }
          return tr
        }
      })
    ]
  }
})
