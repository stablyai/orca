import { Extension } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

const LIST_MARKER = /^(\s*)(?:-|(\d+)\.) /
const BULLET_DASH = /^[ \t]*-(?= )/gm
// The dash stays in the text, so the agent and the transcript still get a markdown list.
const BULLET_CLASS =
  "relative [-webkit-text-fill-color:transparent] after:absolute after:inset-0 after:text-center after:content-['•'] after:[-webkit-text-fill-color:currentColor]"

/** One char per inline leaf keeps text offsets equal to positions inside the textblock. */
function lineLeafText(node: ProseMirrorNode): string {
  return node.type.name === 'hardBreak' ? '\n' : '￼'
}

export type NativeChatListContinuation = { exit: number } | { insert: string } | null

/** Shift+Enter on a `- ` or `N. ` line continues the list; on an empty item it drops the marker. */
export function nativeChatListContinuation(
  lineBefore: string,
  lineAfter: string
): NativeChatListContinuation {
  const match = LIST_MARKER.exec(lineBefore)
  if (!match) {
    return null
  }
  if (lineBefore.slice(match[0].length).trim() === '' && lineAfter.trim() === '') {
    return { exit: lineBefore.length }
  }
  return { insert: `${match[1]}${match[2] ? `${Number(match[2]) + 1}. ` : '- '}` }
}

function bulletDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) {
      return true
    }
    const text = node.textBetween(0, node.content.size, undefined, lineLeafText)
    for (const match of text.matchAll(BULLET_DASH)) {
      const dash = pos + 1 + match.index + match[0].length - 1
      decorations.push(Decoration.inline(dash, dash + 1, { class: BULLET_CLASS }))
    }
    return false
  })
  return DecorationSet.create(doc, decorations)
}

export const NativeChatListContinuation = Extension.create({
  name: 'nativeChatListContinuation',
  // Ahead of HardBreak, which owns Shift-Enter otherwise.
  priority: 101,
  addKeyboardShortcuts() {
    return {
      'Shift-Enter': ({ editor }) => {
        const { state, view } = editor
        const { selection, schema } = state
        const { $from } = selection
        if (!selection.empty || !$from.parent.isTextblock || !schema.nodes.hardBreak) {
          return false
        }
        const block = $from.parent
        const before = block.textBetween(0, $from.parentOffset, undefined, lineLeafText)
        const after = block.textBetween(
          $from.parentOffset,
          block.content.size,
          undefined,
          lineLeafText
        )
        const lineBefore = before.slice(before.lastIndexOf('\n') + 1)
        const step = nativeChatListContinuation(lineBefore, after.split('\n')[0])
        if (!step) {
          return false
        }
        const lineStart = $from.pos - lineBefore.length
        view.dispatch(
          'exit' in step
            ? state.tr.delete(lineStart, lineStart + step.exit)
            : state.tr
                .replaceSelectionWith(schema.nodes.hardBreak.create(), false)
                .insertText(step.insert)
                .scrollIntoView()
        )
        return true
      }
    }
  },
  addProseMirrorPlugins() {
    // shortcut: rescans the whole prompt on each edit; fine at chat-prompt sizes, go incremental if huge drafts lag.
    return [
      new Plugin({
        key: new PluginKey('nativeChatListBullets'),
        state: {
          init: (_config, state) => bulletDecorations(state.doc),
          apply: (tr, set) => (tr.docChanged ? bulletDecorations(tr.doc) : set)
        },
        props: {
          decorations(state) {
            return this.getState(state)
          }
        }
      })
    ]
  }
})
