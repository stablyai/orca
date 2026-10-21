import type { Editor, JSONContent } from '@tiptap/react'

/**
 * Why: an inline image cannot be fitted into `codeBlock` (`text*`), so inserting one at a
 * position inside a fence makes ProseMirror dissolve the block — the remaining code escapes
 * as prose and the language attribute is lost. Wrapping the image in a paragraph makes
 * ProseMirror split the fence instead, leaving both halves intact.
 */
export function buildRichMarkdownImageInsertContent(
  editor: Editor,
  pos: number,
  attrs: { src: string }
): JSONContent {
  const image: JSONContent = { type: 'image', attrs }
  const imageType = editor.schema.nodes.image
  const doc = editor.state.doc
  if (!imageType || pos < 0 || pos > doc.content.size) {
    return image
  }
  const $pos = doc.resolve(pos)
  const index = $pos.index()
  if ($pos.parent.canReplaceWith(index, index, imageType)) {
    return image
  }
  return { type: 'paragraph', content: [image] }
}
