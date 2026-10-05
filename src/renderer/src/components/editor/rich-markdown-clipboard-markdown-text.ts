import type { Editor } from '@tiptap/core'
import { Fragment, type ResolvedPos, type Slice } from '@tiptap/pm/model'

export function serializeRichMarkdownSliceToMarkdown(
  editor: Editor | null,
  slice: Slice,
  $from: ResolvedPos
): string {
  const manager = editor?.markdown
  if (!manager) {
    return slice.content.textBetween(0, slice.content.size, '\n\n')
  }
  const selected = slice.content.firstChild
  const parent = $from.parent
  // Node selections supply the item itself, so its owner must supply the list marker.
  if (
    slice.openStart === 0 &&
    slice.content.childCount === 1 &&
    selected === $from.nodeAfter &&
    selected &&
    (selected.type.name === 'listItem' || selected.type.name === 'taskItem') &&
    ['bulletList', 'orderedList', 'taskList'].includes(parent.type.name)
  ) {
    return manager.serialize({
      type: 'doc',
      content:
        normalizeOpenListContext(
          Fragment.from(parent.copy(slice.content)),
          $from,
          $from.depth,
          $from.depth
        ).toJSON() ?? []
    })
  }
  let inline = slice.content
  let block = inline.firstChild
  let depth = 0
  while (depth < slice.openStart && inline.childCount === 1 && inline.firstChild) {
    block = inline.firstChild
    inline = block.content
    depth++
  }
  // Open textblock edges contain selected text, not its heading marker or code fence.
  if (depth > 0 && depth === slice.openStart && depth === slice.openEnd && block?.isTextblock) {
    if (block.type.spec.code) {
      return inline.textBetween(0, inline.size, '\n')
    }
    const paragraph = block.type.schema.nodes.paragraph
    if (paragraph) {
      return manager.serialize({
        type: 'doc',
        content: Fragment.from(paragraph.create(null, inline)).toJSON() ?? []
      })
    }
  }
  return manager.serialize({
    type: 'doc',
    content: normalizeOpenListContext(slice.content, $from, slice.openStart).toJSON() ?? []
  })
}

function normalizeOpenListContext(
  content: Fragment,
  $from: ResolvedPos,
  openStart: number,
  depth = 1
): Fragment {
  const node = content.firstChild
  if (!node || depth > openStart || depth > $from.depth || node.type !== $from.node(depth).type) {
    return content
  }
  const item = node.firstChild
  const nested = item?.firstChild
  // An open outer item can contain only a nested list after its label was excluded.
  if (
    content.childCount === 1 &&
    node.childCount === 1 &&
    item?.childCount === 1 &&
    depth + 1 < openStart &&
    (item.type.name === 'listItem' || item.type.name === 'taskItem') &&
    nested &&
    ['bulletList', 'orderedList', 'taskList'].includes(nested.type.name)
  ) {
    return normalizeOpenListContext(item.content, $from, openStart, depth + 2)
  }
  let children = normalizeOpenListContext(node.content, $from, openStart, depth + 1)
  // A partial item beside selected siblings still needs its missing leading paragraph.
  const paragraph = node.type.schema.nodes.paragraph
  if (
    paragraph &&
    (node.type.name === 'listItem' || node.type.name === 'taskItem') &&
    children.firstChild?.type !== paragraph
  ) {
    children = Fragment.from(paragraph.create()).append(children)
  }
  // Native slices retain the original list attributes even when earlier items are excluded.
  const attrs =
    node.type.name === 'orderedList' && node.attrs === $from.node(depth).attrs
      ? { ...node.attrs, start: (Number(node.attrs.start) || 1) + $from.index(depth) }
      : node.attrs
  return content.replaceChild(0, node.type.create(attrs, children, node.marks))
}
