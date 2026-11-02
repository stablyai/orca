import type { Editor } from '@tiptap/react'
import { Fragment, type Attrs } from '@tiptap/pm/model'
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
  const index = $from.index(context.itemDepth - 1)
  if (index === 0) {
    return
  }
  const list = $from.node(context.itemDepth - 1)
  editor.view.dispatch(
    state.tr.split($from.before(context.itemDepth), 1, [
      { type: list.type, attrs: withShiftedStart(list.attrs, index) }
    ])
  )
}

/** Keep ordered-list numbering when a list is split or its tail is moved. */
function withShiftedStart(attrs: Attrs, offset: number): Attrs {
  return typeof attrs.start === 'number' ? { ...attrs, start: attrs.start + offset } : attrs
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
  const range = state.selection.$from.blockRange(state.selection.$to, (node) => node === list)
  const selectedEnd = range?.endIndex ?? list.childCount
  const trailing = Fragment.fromArray(list.children.slice(selectedEnd))
  const items = list.children.slice(0, selectedEnd).map((item, index) => {
    const content =
      index === selectedEnd - 1 && trailing.size > 0
        ? item.content.append(
            Fragment.from(
              list.type.create(withShiftedStart(list.attrs, selectedEnd), trailing, list.marks)
            )
          )
        : item.content
    return itemType.create(null, content, item.marks)
  })
  const retyped = state.schema.nodes[LIST_TYPE_FOR_ITEM[target]].create(
    null,
    Fragment.from(items),
    list.marks
  )
  const tr = state.tr.replaceWith(listPos, listPos + list.nodeSize, retyped)
  // Retyping replaces the subtree; keep the selected text instead of the replacement cursor.
  tr.setSelection(TextSelection.create(tr.doc, from, to))
  editor.view.dispatch(tr)
}
