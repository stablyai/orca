import type { Editor } from '@tiptap/core'
import { splitBlockAs } from '@tiptap/pm/commands'
import { TextSelection } from '@tiptap/pm/state'

export function exitHeadingOnEnter(editor: Editor, event: KeyboardEvent): boolean {
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
    return false
  }
  const { selection, schema } = editor.state
  const { $from } = selection
  // Only interior splits need a type override; block edges use the existing keymap.
  if (
    !(selection instanceof TextSelection) ||
    !selection.empty ||
    $from.parent.type.name !== 'heading' ||
    $from.parentOffset === 0 ||
    $from.parentOffset === $from.parent.content.size
  ) {
    return false
  }
  const paragraph = schema.nodes.paragraph
  if (!paragraph) {
    return false
  }
  return editor.commands.command(({ state, dispatch }) => {
    const marks = state.storedMarks ?? selection.$from.marks()
    return splitBlockAs(() => ({ type: paragraph }))(
      state,
      dispatch &&
        ((tr) => {
          tr.ensureMarks(
            marks.filter((mark) => editor.extensionManager.splittableMarks.includes(mark.type.name))
          )
          dispatch(tr)
        })
    )
  })
}
