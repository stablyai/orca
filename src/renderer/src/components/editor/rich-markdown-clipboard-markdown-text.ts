import type { Editor } from '@tiptap/core'
import { Fragment, type Node as ProseMirrorNode, type Slice } from '@tiptap/pm/model'

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
 * Serializes a clipboard slice to markdown source, falling back to
 * ProseMirror's block-joined text when no markdown manager is available.
 *
 * The output matches what the same selection copies in Source mode. A
 * selection wholly inside one textblock carries only that block's inline
 * markdown, because the block's own syntax (heading marker, code fence) sits
 * outside such a selection in source. `enclosingBlock` is the textblock
 * holding the selection.
 */
export function serializeRichMarkdownSliceToMarkdown(
  serializer: RichMarkdownSliceSerializer | undefined,
  slice: Slice,
  enclosingBlock: ProseMirrorNode
): string {
  if (!serializer) {
    return slice.content.textBetween(0, slice.content.size, '\n\n')
  }
  const content: Fragment = slice.content
  if (!content.firstChild?.isInline || !enclosingBlock.isTextblock) {
    return serializer.serialize({ type: 'doc', content: content.toJSON() ?? [] })
  }
  // Why: code content is literal, and the inline serializer escapes markdown
  // characters that must survive a copy out of a code block.
  if (enclosingBlock.type.spec.code) {
    return content.textBetween(0, content.size, '\n')
  }
  // Why: bare inline content renders one block per node; a paragraph supplies
  // an inline context without contributing the enclosing block's own syntax.
  const paragraph = enclosingBlock.type.schema.nodes.paragraph
  if (!paragraph) {
    return content.textBetween(0, content.size, '\n')
  }
  return serializer.serialize({
    type: 'doc',
    content: Fragment.from(paragraph.create(null, content)).toJSON() ?? []
  })
}
