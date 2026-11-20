import { Extension } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { NativeChatHardBreakParagraphs } from './native-chat-hard-break-paragraphs'
import { promptText } from './native-chat-prompt-document'

const LIST_MARKER = /^(\s*)(?:(-)|(\d+)\.) /
const BULLET_MARKER = /^\s*- /
// The dash keeps its width and caret stops; only a bullet is painted over it.
const BULLET_CLASS =
  "relative invisible before:visible before:absolute before:inset-0 before:text-center before:content-['•']"

/** The marker the next item starts with, or null when the line is not a list item. */
export function nextListMarker(line: string): string | null {
  const match = LIST_MARKER.exec(line)
  if (!match) {
    return null
  }
  const [, indent, dash, number] = match
  return `${indent}${dash ?? `${Number(number) + 1}.`} `
}

function bulletDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = []
  doc.forEach((line, offset) => {
    const first = line.firstChild
    const match = first?.isText ? BULLET_MARKER.exec(first.text ?? '') : null
    if (match) {
      const dash = offset + 1 + match[0].length - 2
      decorations.push(Decoration.inline(dash, dash + 1, { class: BULLET_CLASS }))
    }
  })
  return DecorationSet.create(doc, decorations)
}

/** Shift+Enter continues a `- ` or `N. ` list, and on an empty item ends it; the text stays markdown. */
export const NativeChatListContinuation = Extension.create({
  name: 'nativeChatListContinuation',
  // Ahead of HardBreak's Shift-Enter.
  priority: 1000,
  // Bullets and markers are found per paragraph, so every line must be one.
  addExtensions() {
    return [NativeChatHardBreakParagraphs]
  },
  addKeyboardShortcuts() {
    return {
      'Shift-Enter': ({ editor }) => {
        const { state, view } = editor
        const { $from, empty } = state.selection
        if (!empty) {
          return false
        }
        const prefix = promptText(state.doc, $from.start(), $from.pos)
        const line = prefix + promptText(state.doc, $from.pos, $from.end())
        const marker = LIST_MARKER.exec(line)?.[0]
        // A caret before or inside the marker gets a plain newline.
        if (!marker || prefix.length < marker.length) {
          return false
        }
        if (line === marker) {
          view.dispatch(state.tr.delete($from.start(), $from.end()))
          return true
        }
        view.dispatch(
          state.tr
            .split($from.pos)
            .insertText(nextListMarker(line) ?? marker)
            .scrollIntoView()
        )
        return true
      }
    }
  },
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        state: {
          init: (_, state) => bulletDecorations(state.doc),
          apply: (tr, previous) => (tr.docChanged ? bulletDecorations(tr.doc) : previous)
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
