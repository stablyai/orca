import type { Editor, JSONContent } from '@tiptap/react'

/** Wrap inline images in paragraphs so insertion splits code fences without dissolving them into prose or losing their language. */
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
