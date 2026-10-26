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

/** Resolve the nearest list/task item; trying one type first can act on an ancestor and corrupt mixed nesting. */
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
  // Retype mixed items before lifting or schema-list lifts them out of their list and drops the marker.
  if (context.parentItemType && context.parentItemType !== context.itemType) {
    splitListBeforeCursorItem(editor)
    retypeListAtCursor(editor, context.parentItemType)
    return editor.commands.liftListItem(context.parentItemType)
  }
  return editor.commands.liftListItem(context.itemType)
}

/** Split out lifted items before whole-list retyping so remaining siblings retain their markers. */
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

  // Replace the subtree atomically because separately retyping list/items creates schema-invalid intermediate states.
  const itemType = state.schema.nodes[target]
  const items = list.children.map((item) => itemType.create(null, item.content, item.marks))
  const retyped = state.schema.nodes[LIST_TYPE_FOR_ITEM[target]].create(
    null,
    Fragment.from(items),
    list.marks
  )
  const tr = state.tr.replaceWith(listPos, listPos + list.nodeSize, retyped)
  // Size-preserving retyping deletes/reinserts the subtree; restore selection rather than keeping replaceWith’s collapsed cursor.
  tr.setSelection(TextSelection.create(tr.doc, from, to))
  editor.view.dispatch(tr)
}
