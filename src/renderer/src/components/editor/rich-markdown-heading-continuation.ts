import type { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'

/**
 * Why: TipTap's stock Heading node has no Enter override, so the default
 * ProseMirror keymap's splitBlock carries the heading type into the new
 * block. This handler exits heading style on Enter to match Notion/Obsidian.
 */
export function exitHeadingOnEnter(editor: Editor): boolean {
  const { selection, schema } = editor.state
  if (!(selection instanceof TextSelection) || !selection.empty) {
    return false
  }

  const { $from } = selection
  const heading = $from.parent
  if (heading.type.name !== 'heading') {
    return false
  }

  const paragraphType = schema.nodes.paragraph
  if (!paragraphType) {
    return false
  }

  const { state, view } = editor
  const headingStart = $from.before($from.depth)
  const headingEnd = $from.after($from.depth)
  const offset = $from.parentOffset

  if (offset === 0) {
    const paragraph = paragraphType.create()
    const tr = state.tr.insert(headingStart, paragraph)
    // Why: keep the cursor in the heading being pushed down, matching
    // Notion/Obsidian — the new blank paragraph lands above, unfocused.
    tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map($from.pos)))
    view.dispatch(tr.scrollIntoView())
    return true
  }

  if (offset === heading.content.size) {
    const paragraph = paragraphType.create()
    const tr = state.tr.insert(headingEnd, paragraph)
    tr.setSelection(TextSelection.create(tr.doc, headingEnd + 1))
    view.dispatch(tr.scrollIntoView())
    return true
  }

  const before = heading.content.cut(0, offset)
  const after = heading.content.cut(offset)
  if (!heading.type.validContent(before) || !paragraphType.validContent(after)) {
    return false
  }

  const remainingHeading = heading.type.create(heading.attrs, before, heading.marks)
  const newParagraph = paragraphType.create(null, after)
  const tr = state.tr.replaceWith(headingStart, headingEnd, [remainingHeading, newParagraph])
  tr.setSelection(TextSelection.create(tr.doc, headingStart + remainingHeading.nodeSize + 1))
  view.dispatch(tr.scrollIntoView())
  return true
}
