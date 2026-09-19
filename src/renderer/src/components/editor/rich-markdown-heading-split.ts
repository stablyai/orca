import type { Editor } from '@tiptap/core'

export function handleRichMarkdownHeadingEnter(
  editor: Editor,
  event: KeyboardEvent,
  menusClosed: boolean
): boolean {
  if (
    event.key !== 'Enter' ||
    event.shiftKey ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    !menusClosed ||
    event.isComposing ||
    editor.view.composing
  ) {
    return false
  }

  const handled = splitRichMarkdownHeading(editor)
  if (handled) {
    event.preventDefault()
  }
  return handled
}

/** Split a heading in the middle and make the new trailing block a paragraph. */
export function splitRichMarkdownHeading(editor: Editor): boolean {
  const { $from, empty } = editor.state.selection
  if (!empty || $from.parent.type.name !== 'heading') {
    return false
  }
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if (['tableCell', 'tableHeader'].includes($from.node(depth).type.name)) {
      return false
    }
  }
  if ($from.parentOffset === 0 || $from.parentOffset === $from.parent.content.size) {
    return false
  }
  return editor.chain().splitBlock().setParagraph().run()
}
