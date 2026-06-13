import type React from 'react'
import type { Editor } from '@tiptap/react'
import type { SlashCommand, SlashMenuState } from './rich-markdown-slash-command-catalog'

export { slashCommands } from './rich-markdown-slash-command-catalog'
export type {
  SlashCommand,
  SlashCommandGroup,
  SlashCommandIcon,
  SlashCommandId,
  SlashMenuState
} from './rich-markdown-slash-command-catalog'

/**
 * Executes a slash command by first deleting the typed slash text, then
 * delegating to the command's run method. Image is special-cased because
 * window.prompt() is not supported in Electron's renderer process.
 */
export function runSlashCommand(
  editor: Editor,
  slashMenu: { from: number; to: number },
  command: SlashCommand,
  onImageCommand?: () => void,
  onEmojiCommand?: () => void
): void {
  editor.chain().focus().deleteRange({ from: slashMenu.from, to: slashMenu.to }).run()
  // Why: image insertion cannot rely on window.prompt() in Electron, so this
  // command is rerouted into the editor's local image picker flow.
  if (command.id === 'image' && onImageCommand) {
    onImageCommand()
    return
  }
  if (command.id === 'emoji' && onEmojiCommand) {
    onEmojiCommand()
    return
  }
  command.run(editor)
}

/**
 * Inspects the editor selection to decide whether the slash-command menu
 * should be open (and where to position it), or dismissed.
 */
export function syncSlashMenu(
  editor: Editor,
  root: HTMLDivElement | null,
  setSlashMenu: React.Dispatch<React.SetStateAction<SlashMenuState | null>>
): void {
  if (!root || editor.view.composing || !editor.isEditable) {
    setSlashMenu(null)
    return
  }

  const { state, view } = editor
  const { selection } = state
  if (!selection.empty) {
    setSlashMenu(null)
    return
  }

  const { $from } = selection
  if (!$from.parent.isTextblock) {
    setSlashMenu(null)
    return
  }

  const blockTextBeforeCursor = $from.parent.textBetween(0, $from.parentOffset, '\0', '\0')
  const slashMatch = blockTextBeforeCursor.match(/^\s*\/([a-z0-9-]*)$/i)
  if (!slashMatch) {
    setSlashMenu(null)
    return
  }

  const slashOffset = blockTextBeforeCursor.lastIndexOf('/')
  const start = selection.from - ($from.parentOffset - slashOffset)
  const coords = view.coordsAtPos(selection.from)
  const rect = root.getBoundingClientRect()

  setSlashMenu({
    query: slashMatch[1] ?? '',
    from: start,
    to: selection.from,
    left: coords.left - rect.left,
    top: coords.bottom - rect.top + 8
  })
}
