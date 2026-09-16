import type { Editor } from '@tiptap/core'
import {
  buildRichMarkdownCommentBlocks,
  type RichMarkdownCommentBlock
} from './rich-markdown-review-annotations'

type ReviewRailBlocks = {
  doc: Editor['state']['doc']
  markdown: Editor['markdown']
  serialize: NonNullable<Editor['markdown']>['serialize'] | undefined
  blocks: readonly RichMarkdownCommentBlock[]
}

// Keep only the current document per editor; scrolling changes geometry, not source lines.
const blocksByEditor = new WeakMap<Editor, ReviewRailBlocks>()

export function getRichMarkdownReviewRailBlocks(
  editor: Editor
): readonly RichMarkdownCommentBlock[] {
  const doc = editor.state.doc
  const markdown = editor.markdown
  const serialize = markdown?.serialize
  const cached = blocksByEditor.get(editor)
  if (cached?.doc === doc && cached.markdown === markdown && cached.serialize === serialize) {
    return cached.blocks
  }

  const blocks = buildRichMarkdownCommentBlocks(editor)
  blocksByEditor.set(editor, { doc, markdown, serialize, blocks })
  return blocks
}
