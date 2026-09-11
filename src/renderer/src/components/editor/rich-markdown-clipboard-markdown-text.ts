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
 * A selection inside one textblock yields bare inline content, which the
 * manager renders as one block per inline node. Re-wrapping that content in
 * `enclosingBlock` restores inline joining and the block's own syntax (fence,
 * heading marker).
 */
export function serializeRichMarkdownSliceToMarkdown(
  serializer: RichMarkdownSliceSerializer | undefined,
  slice: Slice,
  enclosingBlock: ProseMirrorNode
): string {
  if (!serializer) {
    return slice.content.textBetween(0, slice.content.size, '\n\n')
  }
  let content: Fragment = slice.content
  if (content.firstChild?.isInline && enclosingBlock.isTextblock) {
    content = Fragment.from(
      enclosingBlock.type.create(enclosingBlock.attrs, content, enclosingBlock.marks)
    )
  }
  return serializer.serialize({ type: 'doc', content: content.toJSON() ?? [] })
}
