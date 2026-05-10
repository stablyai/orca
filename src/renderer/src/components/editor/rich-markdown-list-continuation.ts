import type { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'

function getEmptyListItemContext(editor: Editor): {
  listDepth: number
  listItemDepth: number
} | null {
  const { selection } = editor.state

  if (!(selection instanceof TextSelection) || !selection.empty) {
    return null
  }

  const { $from } = selection
  const paragraph = $from.parent
  if (
    paragraph.type.name !== 'paragraph' ||
    paragraph.content.size > 0 ||
    $from.parentOffset !== 0
  ) {
    return null
  }

  let listItemDepth = -1
  for (let depth = $from.depth - 1; depth >= 0; depth -= 1) {
    if ($from.node(depth).type.name === 'listItem') {
      listItemDepth = depth
      break
    }
  }

  const listDepth = listItemDepth - 1
  if (listItemDepth < 0 || listDepth < 0) {
    return null
  }

  return { listDepth, listItemDepth }
}

export function commitEmptyOrderedListMarkerAsText(editor: Editor): boolean {
  const context = getEmptyListItemContext(editor)
  if (!context) {
    return false
  }

  const { state, view } = editor
  const { schema } = state
  const { $from } = state.selection
  const list = $from.node(context.listDepth)
  const listItem = $from.node(context.listItemDepth)
  const parentDepth = context.listDepth - 1

  if (
    list.type.name !== 'orderedList' ||
    list.childCount !== 1 ||
    listItem.childCount !== 1 ||
    (parentDepth >= 0 && $from.node(parentDepth).type.name === 'listItem')
  ) {
    return false
  }

  const paragraphType = schema.nodes.paragraph
  if (!paragraphType) {
    return false
  }

  const start = typeof list.attrs.start === 'number' ? list.attrs.start : 1
  const markerParagraph = paragraphType.create(null, schema.text(`${start}.`))
  const nextParagraph = paragraphType.create()
  const from = $from.before(context.listDepth)
  const to = from + list.nodeSize
  const tr = state.tr.replaceWith(from, to, [markerParagraph, nextParagraph])
  // Why: `1. ` is ambiguous: it may be a list shortcut, or literal text.
  // Enter on the still-empty item should preserve what the user typed instead
  // of treating it as an abandoned list and erasing the marker.
  tr.setSelection(TextSelection.create(tr.doc, from + markerParagraph.nodeSize + 1))
  view.dispatch(tr.scrollIntoView())
  return true
}

export function isSingleEmptyTopLevelOrderedList(editor: Editor): boolean {
  const context = getEmptyListItemContext(editor)
  if (!context) {
    return false
  }

  const { $from } = editor.state.selection
  const list = $from.node(context.listDepth)
  const listItem = $from.node(context.listItemDepth)
  const parentDepth = context.listDepth - 1
  return (
    list.type.name === 'orderedList' &&
    list.childCount === 1 &&
    listItem.childCount === 1 &&
    !(parentDepth >= 0 && $from.node(parentDepth).type.name === 'listItem')
  )
}

export function collapseEmptyListContinuationParagraph(editor: Editor): boolean {
  const context = getEmptyListItemContext(editor)
  if (!context) {
    return false
  }

  const { state, view } = editor
  const { $from } = state.selection
  const list = $from.node(context.listDepth)
  const listItem = $from.node(context.listItemDepth)
  const childIndex = $from.index(context.listItemDepth)

  if (list.type.name !== 'orderedList' || childIndex <= 0) {
    return false
  }

  const previousChild = listItem.child(childIndex - 1)
  if (previousChild.type.name !== 'paragraph' || previousChild.content.size === 0) {
    return false
  }

  const from = $from.before($from.depth)
  const to = $from.after($from.depth)
  const previousParagraphEnd = from - 1
  const tr = state.tr.delete(from, to)
  // Why: after backing out of a nested list, Backspace on the blank
  // continuation line should return to the parent item's text, not unwrap the
  // numbered list item and remove its marker.
  tr.setSelection(TextSelection.create(tr.doc, previousParagraphEnd))
  view.dispatch(tr.scrollIntoView())
  return true
}

export function convertEmptyNestedOrderedItemToContinuation(editor: Editor): boolean {
  const context = getEmptyListItemContext(editor)
  if (!context) {
    return false
  }

  const { state, view } = editor
  const { schema } = state
  const { $from } = state.selection
  const parentListItemDepth = context.listItemDepth - 2
  if (parentListItemDepth < 0) {
    return false
  }

  const list = $from.node(context.listDepth)
  const parentListItem = $from.node(parentListItemDepth)
  if (list.type.name !== 'orderedList' || parentListItem.type.name !== 'listItem') {
    return false
  }

  if (list.childCount !== 1) {
    return false
  }

  const replacementParagraph = schema.nodes.paragraph?.create()
  if (!replacementParagraph) {
    return false
  }

  const from = $from.before(context.listDepth)
  const to = from + list.nodeSize
  const tr = state.tr.replaceWith(from, to, replacementParagraph)
  // Why: an empty nested ordered item is usually the user asking for a
  // continuation line under the parent item, not another numbered sublist.
  tr.setSelection(TextSelection.create(tr.doc, from + 1))
  view.dispatch(tr.scrollIntoView())
  return true
}
