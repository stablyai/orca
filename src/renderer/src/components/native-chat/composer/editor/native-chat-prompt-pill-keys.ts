import { Extension } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { TextSelection, type EditorState } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

// A pill: an inline atom the user can select (a skill, file, image, agent or bot). Not a hard break.
function isPill(node: ProseMirrorNode | null | undefined): node is ProseMirrorNode {
  return Boolean(node?.isInline && node.isAtom && !node.isText && node.type.spec.selectable)
}

function pillBeside(state: EditorState, side: 'before' | 'after'): ProseMirrorNode | null {
  const { selection } = state
  if (!selection.empty) {
    return null
  }
  const node = side === 'before' ? selection.$from.nodeBefore : selection.$from.nodeAfter
  return isPill(node) ? node : null
}

const RIGHT_TO_LEFT = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/u

function isRightToLeft(view: EditorView): boolean {
  return (
    RIGHT_TO_LEFT.test(view.state.selection.$from.parent.textContent) ||
    getComputedStyle(view.dom).direction === 'rtl'
  )
}

/** Backspace or Delete takes a pill beside the caret in one press, and a plain arrow steps over it
 *  in one press. ProseMirror's own arrow first selects the pill, so crossing one took two presses;
 *  deleting was left to the browser, which some engines do in two presses or not at all. */
export function nativeChatPromptPillKey(
  view: EditorView,
  key: 'Backspace' | 'Delete' | 'ArrowLeft' | 'ArrowRight'
): boolean {
  const { state } = view
  // A composition owns the caret; leave its keys alone.
  if (view.composing) {
    return false
  }
  const arrow = key === 'ArrowLeft' || key === 'ArrowRight'
  // Left is forward in right-to-left text; leave arrows there to ProseMirror, which knows that.
  if (arrow && isRightToLeft(view)) {
    return false
  }
  const side = key === 'Backspace' || key === 'ArrowLeft' ? 'before' : 'after'
  const pill = pillBeside(state, side)
  if (!pill) {
    return false
  }
  const at = state.selection.from
  const [from, to] = side === 'before' ? [at - pill.nodeSize, at] : [at, at + pill.nodeSize]
  if (!arrow) {
    view.dispatch(state.tr.delete(from, to).scrollIntoView())
  } else {
    const caret = side === 'before' ? from : to
    view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, caret)).scrollIntoView())
  }
  return true
}

export const NativeChatPromptPillKeys = Extension.create({
  name: 'nativeChatPromptPillKeys',
  // Ahead of the default keymap, whose Backspace and arrows would otherwise run first.
  priority: 1000,
  addKeyboardShortcuts() {
    const run = (key: Parameters<typeof nativeChatPromptPillKey>[1]) => () =>
      nativeChatPromptPillKey(this.editor.view, key)
    return {
      Backspace: run('Backspace'),
      Delete: run('Delete'),
      ArrowLeft: run('ArrowLeft'),
      ArrowRight: run('ArrowRight')
    }
  }
})
