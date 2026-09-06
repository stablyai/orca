import type { Editor } from '@tiptap/react'
import { Fragment } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'

type ListItemTypeName = 'listItem' | 'taskItem'

const LIST_TYPE_FOR_ITEM: Record<ListItemTypeName, string> = {
  listItem: 'bulletList',
  taskItem: 'taskList'
}

function isListItemType(name: string): name is ListItemTypeName {
  return name === 'listItem' || name === 'taskItem'
}

type ListItemContext = {
  /** Closest list item at the cursor. */
  itemType: ListItemTypeName
  itemDepth: number
  /** List item enclosing that one, when the cursor sits in a nested list. */
  parentItemType: ListItemTypeName | null
}

/**
 * Why: bullet and task lists nest into each other, so trying `listItem` first
 * and falling back to `taskItem` picks the wrong node — the command walks up to
 * any ancestor of that type and acts on *it*, mangling the surrounding list.
 */
function resolveListItemContext(editor: Editor): ListItemContext | null {
  const { $from } = editor.state.selection
  let found: { itemType: ListItemTypeName; itemDepth: number } | null = null
  for (let depth = $from.depth; depth > 0; depth--) {
    const name = $from.node(depth).type.name
    if (!isListItemType(name)) {
      continue
    }
    if (!found) {
      found = { itemType: name, itemDepth: depth }
      continue
    }
    return { ...found, parentItemType: name }
  }
  return found ? { ...found, parentItemType: null } : null
}

export function indentRichMarkdownListItem(editor: Editor): boolean {
  return editor.commands.sinkListItem(resolveListItemContext(editor)?.itemType ?? 'listItem')
}

export function outdentRichMarkdownListItem(editor: Editor): boolean {
  const context = resolveListItemContext(editor)
  if (!context) {
    return false
  }
  // Why: the schema forbids a listItem sibling inside a taskList (and vice
  // versa), so a mixed nest cannot lift as-is — prosemirror-schema-list would
  // silently lift the item *out* of its list, dropping its marker entirely.
  // Retype the item to match the list it is about to join, then lift normally.
  if (context.parentItemType && context.parentItemType !== context.itemType) {
    splitListBeforeCursorItem(editor)
    retypeListAtCursor(editor, context.parentItemType)
    return editor.commands.liftListItem(context.parentItemType)
  }
  return editor.commands.liftListItem(context.itemType)
}

/**
 * Why: retyping is a whole-list operation, so peel the cursor's item (and the
 * siblings that will follow it out) into their own list first — items staying
 * behind must keep their original marker.
 */
function splitListBeforeCursorItem(editor: Editor): void {
  const context = resolveListItemContext(editor)
  if (!context) {
    return
  }
  const { state } = editor
  const { $from } = state.selection
  if ($from.index(context.itemDepth - 1) === 0) {
    return
  }
  editor.view.dispatch(state.tr.split($from.before(context.itemDepth), 1))
}

function retypeListAtCursor(editor: Editor, target: ListItemTypeName): void {
  const context = resolveListItemContext(editor)
  if (!context) {
    return
  }
  const { state } = editor
  const { from, to } = state.selection
  const listPos = state.selection.$from.before(context.itemDepth - 1)
  const list = state.doc.nodeAt(listPos)
  if (!list) {
    return
  }

  // Why: retyping the list and its items in separate steps would leave an
  // intermediate doc the schema rejects, so swap the whole subtree at once.
  const itemType = state.schema.nodes[target]
  const items = list.children.map((item) => itemType.create(null, item.content, item.marks))
  const retyped = state.schema.nodes[LIST_TYPE_FOR_ITEM[target]].create(
    null,
    Fragment.from(items),
    list.marks
  )
  const tr = state.tr.replaceWith(listPos, listPos + list.nodeSize, retyped)
  // Why: replaceWith treats the old subtree as deleted, collapsing the cursor to
  // the range edge — the retype is size-preserving, so restore it verbatim.
  tr.setSelection(TextSelection.create(tr.doc, from, to))
  editor.view.dispatch(tr)
}
