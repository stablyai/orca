import type { Editor } from '@tiptap/core'
import {
  Fragment,
  type Node as ProseMirrorNode,
  type ResolvedPos,
  type Slice
} from '@tiptap/pm/model'

type RichMarkdownSliceSerializer = {
  serialize: (docOrContent: { type: string; content: unknown }) => string
}

type RichMarkdownSerializerStorage = {
  markdown?: { manager?: unknown }
}

/**
 * Reads the manager registered by the markdown extension. Absent on editors
 * built without it, and on the lightweight views some handler tests construct.
 */
export function getRichMarkdownSliceSerializer(
  editor: Editor | null | undefined
): RichMarkdownSliceSerializer | undefined {
  const manager = (editor?.storage as RichMarkdownSerializerStorage | undefined)?.markdown?.manager
  if (manager && typeof (manager as RichMarkdownSliceSerializer).serialize === 'function') {
    return manager as RichMarkdownSliceSerializer
  }
  return undefined
}

/**
 * Ancestors whose markdown syntax is emitted per child, so a slice taken from
 * inside one renders without that syntax unless the ancestor is rebuilt around
 * it. Containers absent here either contribute no per-child syntax
 * (`detailsContent`) or have no standalone markdown spelling (`tableRow`).
 */
const SYNTAX_BEARING_ANCESTORS = new Set([
  'blockquote',
  'bulletList',
  'orderedList',
  'taskList',
  'table'
])

/**
 * Serializes a clipboard slice to markdown source, falling back to
 * ProseMirror's block-joined text when no markdown manager is available.
 *
 * The output matches what the same selection copies in Source mode. A
 * selection wholly inside one textblock carries only that block's inline
 * markdown, because the block's own syntax (heading marker, code fence) sits
 * outside such a selection in source. `$from` resolves the selection start and
 * `to` is its end position, together giving the ancestor shared by both ends.
 */
export function serializeRichMarkdownSliceToMarkdown(
  serializer: RichMarkdownSliceSerializer | undefined,
  slice: Slice,
  $from: ResolvedPos,
  to: number
): string {
  if (!serializer) {
    return slice.content.textBetween(0, slice.content.size, '\n\n')
  }
  const content: Fragment = slice.content
  const enclosingBlock = $from.parent
  if (content.firstChild?.isInline && enclosingBlock.isTextblock) {
    return serializeInlineContent(serializer, content, enclosingBlock)
  }
  return serializer.serialize({
    type: 'doc',
    content: wrapInSharedAncestor(content, $from, to).toJSON() ?? []
  })
}

/**
 * Rebuilds the ancestor `$from` and `to` share, which ProseMirror strips from a
 * slice taken inside a single list, blockquote, or table.
 */
function wrapInSharedAncestor(content: Fragment, $from: ResolvedPos, to: number): Fragment {
  const sharedDepth = to <= $from.pos ? $from.depth : $from.sharedDepth(to)
  for (let depth = sharedDepth; depth >= 1; depth--) {
    const ancestor = $from.node(depth)
    if (!SYNTAX_BEARING_ANCESTORS.has(ancestor.type.name)) {
      continue
    }
    const wrapped = wrapFromDepth(content, $from, sharedDepth, depth)
    return wrapped ?? content
  }
  return content
}

/**
 * Rebuilds every container between `sharedDepth` and `ancestorDepth`, so a
 * cell-level slice reaches its table through the row that holds it.
 */
function wrapFromDepth(
  content: Fragment,
  $from: ResolvedPos,
  sharedDepth: number,
  ancestorDepth: number
): Fragment | undefined {
  let wrapped = content
  for (let depth = sharedDepth; depth > ancestorDepth; depth--) {
    const intermediate = $from.node(depth)
    if (!intermediate.type.validContent(wrapped)) {
      return undefined
    }
    wrapped = Fragment.from(intermediate.type.create(intermediate.attrs, wrapped))
  }
  const ancestor = $from.node(ancestorDepth)
  const body = prependTableHeader(wrapped, ancestor, $from, ancestorDepth)
  if (!ancestor.type.validContent(body)) {
    return undefined
  }
  return Fragment.from(ancestor.type.create(ancestorAttrs(ancestor, $from, ancestorDepth), body))
}

/**
 * A markdown table needs its header row and delimiter, which a body-row
 * selection excludes.
 */
function prependTableHeader(
  content: Fragment,
  ancestor: ProseMirrorNode,
  $from: ResolvedPos,
  ancestorDepth: number
): Fragment {
  const header = ancestor.firstChild
  if (ancestor.type.name !== 'table' || !header || $from.index(ancestorDepth) === 0) {
    return content
  }
  return Fragment.from(header).append(content)
}

/** An ordered subset numbers from the first selected item. */
function ancestorAttrs(
  ancestor: ProseMirrorNode,
  $from: ResolvedPos,
  ancestorDepth: number
): Record<string, unknown> {
  if (ancestor.type.name !== 'orderedList') {
    return ancestor.attrs
  }
  const start = Number(ancestor.attrs.start) || 1
  return { ...ancestor.attrs, start: start + $from.index(ancestorDepth) }
}

/**
 * Bare inline content renders one block per node, so it needs an inline
 * context. Code content is literal, and that context escapes markdown
 * characters that must survive a copy out of a code block.
 */
function serializeInlineContent(
  serializer: RichMarkdownSliceSerializer,
  content: Fragment,
  enclosingBlock: ProseMirrorNode
): string {
  if (enclosingBlock.type.spec.code) {
    return content.textBetween(0, content.size, '\n')
  }
  const paragraph = enclosingBlock.type.schema.nodes.paragraph
  if (!paragraph) {
    return content.textBetween(0, content.size, '\n')
  }
  return serializer.serialize({
    type: 'doc',
    content: Fragment.from(paragraph.create(null, content)).toJSON() ?? []
  })
}
