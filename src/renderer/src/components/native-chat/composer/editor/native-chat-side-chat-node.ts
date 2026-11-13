import {
  InputRule,
  Node,
  ReactNodeViewRenderer,
  type Editor,
  type JSONContent
} from '@tiptap/react'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { NativeChatSideChatPill } from './NativeChatSideChatPill'

export const SIDE_CHAT_NODE = 'nativeChatSideChat'
// A literal space only, so the token is exactly what was typed and the draft text never changes.
const LEADING_COMMAND = /^\/(?:btw|side) /i
// The pill only means "side chat" where the whole draft parses as one: first, in the first line.
const PILL_POSITION = 1

type SideChatStorage = { enabled: boolean }

declare module '@tiptap/core' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Tiptap Storage requires declaration merging.
  interface Storage {
    nativeChatSideChat: SideChatStorage
  }
}

function leadingCommandPill(state: EditorState): Transaction | null {
  const first = state.doc.firstChild?.firstChild
  const match = first?.isText ? LEADING_COMMAND.exec(first.text ?? '') : null
  return match
    ? state.tr.replaceWith(
        PILL_POSITION,
        PILL_POSITION + match[0].length,
        state.schema.nodes[SIDE_CHAT_NODE].create({ token: match[0] })
      )
    : null
}

/** Pills found where `keep` says no go back to the text they stand for. */
function pillsToText(state: EditorState, keep: (pos: number) => boolean): Transaction | null {
  const found: { pos: number; node: ProseMirrorNode }[] = []
  state.doc.descendants((node, pos) => {
    if (node.type.name === SIDE_CHAT_NODE && !keep(pos)) {
      found.push({ pos, node })
    }
  })
  if (found.length === 0) {
    return null
  }
  const tr = state.tr
  for (const { pos, node } of found.toReversed()) {
    tr.replaceWith(pos, pos + node.nodeSize, state.schema.text(String(node.attrs.token)))
  }
  return tr
}

/** A picked `/btw` or `/side` row: its completed text becomes the pill. */
export function pillLeadingSideChatCommand(editor: Editor): Transaction | null {
  return editor.storage.nativeChatSideChat.enabled ? leadingCommandPill(editor.state) : null
}

/** After availability changes or a whole draft loads: a leading command shows as the pill exactly
 *  where Send opens it as a side chat. Also redraws the empty-question placeholder. */
export function syncSideChatPill(editor: Editor, enabled: boolean): void {
  editor.storage.nativeChatSideChat.enabled = enabled
  const { state } = editor
  const tr = (enabled ? leadingCommandPill(state) : pillsToText(state, () => false)) ?? state.tr
  editor.view.dispatch(tr.setMeta('preventUpdate', true).setMeta('addToHistory', false))
}

/** Saved drafts hold the pill as its text, so a build or window without this node keeps the draft. */
export function withSideChatPillsAsText(node: JSONContent): JSONContent {
  if (!node.content) {
    return node
  }
  const content: JSONContent[] = []
  for (const child of node.content) {
    const next =
      child.type === SIDE_CHAT_NODE
        ? { type: 'text', text: String(child.attrs?.token ?? '') }
        : withSideChatPillsAsText(child)
    const previous = content.at(-1)
    if (next.type === 'text' && previous?.type === 'text' && !next.marks && !previous.marks) {
      content[content.length - 1] = {
        ...previous,
        text: `${previous.text ?? ''}${next.text ?? ''}`
      }
    } else {
      content.push(next)
    }
  }
  return { ...node, content }
}

/** `token` is the typed `/btw ` or `/side `, its space included, so the draft text never changes. */
export const NativeChatSideChat = Node.create<{ placeholder: () => string }, SideChatStorage>({
  name: SIDE_CHAT_NODE,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addOptions: () => ({ placeholder: () => '' }),
  // Set by the composer: whether Send opens this draft as a side chat.
  addStorage: () => ({ enabled: false }),
  addNodeView: () => ReactNodeViewRenderer(NativeChatSideChatPill),
  addAttributes: () => ({ token: { default: '' } }),
  renderText: ({ node }) => node.attrs.token,
  renderHTML: ({ node }) => ['span', { 'data-native-chat-side-chat': '' }, node.attrs.token],
  addInputRules() {
    return [
      new InputRule({
        find: /^\/(?:btw|side) $/i,
        // Backspace leaves the typed command, not an undo back to its space.
        undoable: false,
        handler: ({ state, range, match }) => {
          if (range.from !== PILL_POSITION || !this.storage.enabled) {
            return null
          }
          state.tr.replaceWith(range.from, range.to, this.type.create({ token: match[0] }))
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
    const { storage } = this
    const { placeholder } = this.options
    return [
      new Plugin({
        // Text typed or dropped before the pill would send a plain message under a side-chat label.
        appendTransaction: (transactions, _old, state) =>
          transactions.some((tr) => tr.docChanged)
            ? pillsToText(state, (pos) => pos === PILL_POSITION)
            : null,
        props: {
          decorations: (state) => {
            const { doc } = state
            const only = doc.childCount === 1 ? doc.firstChild : null
            if (
              !storage.enabled ||
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
