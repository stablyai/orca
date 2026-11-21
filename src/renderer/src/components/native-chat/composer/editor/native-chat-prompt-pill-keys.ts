import { Extension } from '@tiptap/core'
import type { Node as ProseMirrorNode, ResolvedPos } from '@tiptap/pm/model'
import { TextSelection, type EditorState } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { isMacUserAgent } from '@/app-shell/platform/user-agent-platform'

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
    return arrow && crossLineEdge(view, side)
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

/**
 * An arrow at a line edge goes to the next line's edge, or stays at the first or last place.
 * The browser skips the place before a pill there, or moves the caret where ProseMirror moves it
 * back.
 */
function crossLineEdge(view: EditorView, side: 'before' | 'after'): boolean {
  const { selection, doc } = view.state
  const { $from } = selection
  const edge = side === 'before' ? 0 : $from.parent.content.size
  if (!selection.empty || $from.depth !== 1 || $from.parentOffset !== edge) {
    return false
  }
  const next = side === 'before' ? $from.before() - 1 : $from.after() + 1
  if (next > 0 && next < doc.content.size) {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, next)).scrollIntoView())
  }
  return true
}

const hasPill = (block: ProseMirrorNode | null): boolean =>
  block?.children.some((node) => isPill(node)) === true

type LineMove = 'up' | 'down' | 'start' | 'end'

/** The caret place at the start or end of the caret's line, by layout. */
function lineEdge(view: EditorView, $head: ResolvedPos, end: boolean): number | null {
  const caret = view.coordsAtPos($head.pos)
  const box = view.dom.getBoundingClientRect()
  const top = (caret.top + caret.bottom) / 2
  const place = view.posAtCoords({ left: end ? box.right - 1 : box.left + 1, top })
  // The editor's padding is outside each line: the place there is between two lines.
  return place && Math.min(Math.max(place.pos, $head.start()), $head.end())
}

/** The caret place on the line above or below, by layout; null on the first or last line. */
function nextLine(view: EditorView, head: number, step: -1 | 1): number | null {
  const caret = view.coordsAtPos(head)
  const box = view.dom.getBoundingClientRect()
  // A line with a pill is taller than its caret: step on until the place is on another line.
  for (
    let top = step < 0 ? caret.top - 1 : caret.bottom + 1;
    top > box.top && top < box.bottom;
    top += step * 2
  ) {
    const place = view.posAtCoords({ left: caret.left, top })
    const line = place && view.coordsAtPos(place.pos)
    if (line && (step < 0 ? line.bottom <= caret.top + 1 : line.top >= caret.bottom - 1)) {
      // The middle of that line, not its edge, where a pill may not reach.
      const middle = (line.top + line.bottom) / 2
      return view.posAtCoords({ left: caret.left, top: middle })?.pos ?? place.pos
    }
  }
  return null
}

/**
 * Up, Down and the line start and end keys move by layout from the place before a pill, and Up and
 * Down onto a line with a pill. The browser finds no caret place before a pill: its own move stops
 * there, or lands after the pill. Up on the first line goes to its start, Down on the last to its end.
 */
export function nativeChatPromptLineKey(
  view: EditorView,
  move: LineMove,
  extend: boolean
): boolean {
  const { state } = view
  if (view.composing || isRightToLeft(view)) {
    return false
  }
  const { $head, anchor } = state.selection
  const vertical = move === 'up' || move === 'down'
  const step = move === 'up' ? -1 : 1
  const ontoPill =
    vertical && hasPill(state.doc.maybeChild($head.index(0) + step)) && view.endOfTextblock(move)
  if (!isPill($head.nodeAfter) && !ontoPill) {
    return false
  }
  const target =
    (vertical ? nextLine(view, $head.pos, step) : null) ??
    lineEdge(view, $head, move === 'end' || move === 'down')
  if (target === null) {
    return false
  }
  view.dispatch(
    state.tr
      .setSelection(TextSelection.create(state.doc, extend ? anchor : target, target))
      .scrollIntoView()
  )
  return true
}

// macOS moves to a line edge with Cmd and an arrow; Home and End there scroll.
const LINE_KEYS: Record<string, LineMove> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ...(isMacUserAgent()
    ? { 'Mod-ArrowLeft': 'start', 'Mod-ArrowRight': 'end' }
    : { Home: 'start', End: 'end' })
}

export const NativeChatPromptPillKeys = Extension.create({
  name: 'nativeChatPromptPillKeys',
  // Ahead of the default keymap, whose Backspace and arrows would otherwise run first.
  priority: 1000,
  addKeyboardShortcuts() {
    const run = (key: Parameters<typeof nativeChatPromptPillKey>[1]) => () =>
      nativeChatPromptPillKey(this.editor.view, key)
    const lineKeys = Object.entries(LINE_KEYS).flatMap(([key, move]) => [
      [key, () => nativeChatPromptLineKey(this.editor.view, move, false)],
      [`Shift-${key}`, () => nativeChatPromptLineKey(this.editor.view, move, true)]
    ])
    return {
      Backspace: run('Backspace'),
      Delete: run('Delete'),
      ArrowLeft: run('ArrowLeft'),
      ArrowRight: run('ArrowRight'),
      ...Object.fromEntries(lineKeys)
    }
  }
})
