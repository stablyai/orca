import { InputRule, Node, ReactNodeViewRenderer } from '@tiptap/react'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { NativeChatSideChatPill } from './NativeChatSideChatPill'

export const SIDE_CHAT_NODE = 'nativeChatSideChat'
const LEADING_COMMAND = /^\/(btw|side)\s/i
// The pill only means "side chat" where the whole draft parses as one: first, in the first line.
const PILL_POSITION = 1

type SideChatOptions = { enabled: () => boolean; placeholder: () => string }

function commandToken(name: string): string {
  return `/${name} `
}

/** Turns a draft-leading `/btw ` or `/side ` into the pill; null when the draft does not start so. */
export function pillLeadingSideChatCommand(state: EditorState): Transaction | null {
  const first = state.doc.firstChild?.firstChild
  const match = first?.isText ? LEADING_COMMAND.exec(first.text ?? '') : null
  if (!match) {
    return null
  }
  return state.tr.replaceWith(
    PILL_POSITION,
    PILL_POSITION + match[0].length,
    state.schema.nodes[SIDE_CHAT_NODE].create({ token: commandToken(match[1]) })
  )
}

function misplacedPills(doc: ProseMirrorNode): { pos: number; node: ProseMirrorNode }[] {
  const found: { pos: number; node: ProseMirrorNode }[] = []
  doc.descendants((node, pos) => {
    if (node.type.name === SIDE_CHAT_NODE && pos !== PILL_POSITION) {
      found.push({ pos, node })
    }
  })
  return found
}

/** `token` is the typed `/btw ` or `/side `, its space included, so the draft text never changes. */
export const NativeChatSideChat = Node.create<SideChatOptions>({
  name: SIDE_CHAT_NODE,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addOptions: () => ({ enabled: () => false, placeholder: () => '' }),
  addNodeView: () => ReactNodeViewRenderer(NativeChatSideChatPill),
  addAttributes: () => ({ token: { default: '' } }),
  renderText: ({ node }) => node.attrs.token,
  renderHTML: ({ node }) => ['span', { 'data-native-chat-side-chat': '' }, node.attrs.token],
  addInputRules() {
    return [
      new InputRule({
        find: /^\/(btw|side)\s$/i,
        // Backspace leaves the typed command, not an undo back to its space.
        undoable: false,
        handler: ({ state, range, match }) => {
          if (range.from !== PILL_POSITION || !this.options.enabled()) {
            return null
          }
          state.tr.replaceWith(
            range.from,
            range.to,
            this.type.create({ token: commandToken(match[1] ?? '') })
          )
          return undefined
        }
      })
    ]
  },
  addKeyboardShortcuts() {
    return {
      Backspace: ({ editor }) => {
        const { selection } = editor.state
        const pill = selection.$from.nodeBefore
        if (!selection.empty || pill?.type !== this.type) {
          return false
        }
        // Back to the typed command; a question after it keeps its space.
        const token = String(pill.attrs.token)
        const text = selection.$from.nodeAfter ? token : token.trimEnd()
        const from = selection.from - pill.nodeSize
        const tr = editor.state.tr.replaceWith(from, selection.from, editor.schema.text(text))
        editor.view.dispatch(
          tr.setSelection(TextSelection.create(tr.doc, from + token.trimEnd().length))
        )
        return true
      }
    }
  },
  addProseMirrorPlugins() {
    const { enabled, placeholder } = this.options
    return [
      new Plugin({
        // Text typed or dropped before the pill would send a plain message under a side-chat label.
        appendTransaction: (transactions, _old, state) => {
          if (!transactions.some((tr) => tr.docChanged)) {
            return null
          }
          const misplaced = misplacedPills(state.doc)
          if (misplaced.length === 0) {
            return null
          }
          const tr = state.tr
          for (const { pos, node } of misplaced.toReversed()) {
            tr.replaceWith(pos, pos + node.nodeSize, state.schema.text(String(node.attrs.token)))
          }
          return tr
        },
        props: {
          decorations: (state) => {
            const { doc } = state
            const only = doc.childCount === 1 ? doc.firstChild : null
            if (
              !enabled() ||
              only?.childCount !== 1 ||
              only.firstChild?.type.name !== SIDE_CHAT_NODE
            ) {
              return null
            }
            const text = placeholder()
            // After the caret, as the composer's own placeholder reads; the pill already says side chat.
            return DecorationSet.create(doc, [
              Decoration.widget(
                PILL_POSITION + 1,
                () => {
                  const hint = document.createElement('span')
                  hint.textContent = text
                  hint.setAttribute('aria-hidden', 'true')
                  hint.className = 'pointer-events-none select-none text-chat-foreground-faint'
                  return hint
                },
                { side: 1, key: `side-chat-placeholder:${text}`, ignoreSelection: true }
              )
            ])
          }
        }
      })
    ]
  }
})
