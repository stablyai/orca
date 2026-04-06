import React from 'react'
import type { Editor } from '@tiptap/react'
import { Heading1, Heading2, Heading3, ImageIcon, List, ListOrdered, Quote } from 'lucide-react'

export type SlashMenuState = {
  query: string
  from: number
  to: number
  left: number
  top: number
}

export type SlashCommandId =
  | 'text'
  | 'heading-1'
  | 'heading-2'
  | 'heading-3'
  | 'task-list'
  | 'bullet-list'
  | 'ordered-list'
  | 'blockquote'
  | 'code-block'
  | 'divider'
  | 'image'

export type SlashCommand = {
  id: SlashCommandId
  label: string
  aliases: string[]
  icon: React.ComponentType<{ className?: string }>
  description: string
  run: (editor: Editor) => void
}

/**
 * Executes a slash command by first deleting the typed slash text, then
 * delegating to the command's run method. Image is special-cased because
 * window.prompt() is not supported in Electron's renderer process.
 */
export function runSlashCommand(
  editor: Editor,
  slashMenu: { from: number; to: number },
  command: SlashCommand,
  onImageCommand?: () => void
): void {
  editor.chain().focus().deleteRange({ from: slashMenu.from, to: slashMenu.to }).run()
  // Why: image insertion cannot rely on window.prompt() in Electron, so this
  // command is rerouted into the editor's local image picker flow.
  if (command.id === 'image' && onImageCommand) {
    onImageCommand()
    return
  }
  command.run(editor)
}

export const slashCommands: SlashCommand[] = [
  {
    id: 'text',
    label: 'Text',
    aliases: ['paragraph', 'plain'],
    icon: List,
    description: 'Start a normal paragraph.',
    run: (editor) => {
      editor.chain().focus().setParagraph().run()
    }
  },
  {
    id: 'heading-1',
    label: 'Heading 1',
    aliases: ['h1', 'title'],
    icon: Heading1,
    description: 'Large section heading.',
    run: (editor) => {
      // Use setHeading (not toggleHeading) so the slash command is idempotent —
      // invoking "/h1" on an existing H1 should keep it as H1, not revert to paragraph.
      editor.chain().focus().setHeading({ level: 1 }).run()
    }
  },
  {
    id: 'heading-2',
    label: 'Heading 2',
    aliases: ['h2'],
    icon: Heading2,
    description: 'Medium section heading.',
    run: (editor) => {
      // Use setHeading (not toggleHeading) so the slash command is idempotent —
      // invoking "/h2" on an existing H2 should keep it as H2, not revert to paragraph.
      editor.chain().focus().setHeading({ level: 2 }).run()
    }
  },
  {
    id: 'heading-3',
    label: 'Heading 3',
    aliases: ['h3'],
    icon: Heading3,
    description: 'Small section heading.',
    run: (editor) => {
      // Use setHeading (not toggleHeading) so the slash command is idempotent —
      // invoking "/h3" on an existing H3 should keep it as H3, not revert to paragraph.
      editor.chain().focus().setHeading({ level: 3 }).run()
    }
  },
  {
    id: 'task-list',
    label: 'To-do List',
    aliases: ['todo', 'task', 'checkbox'],
    icon: List,
    description: 'Create a checklist.',
    run: (editor) => {
      editor.chain().focus().toggleTaskList().run()
    }
  },
  {
    id: 'bullet-list',
    label: 'Bullet List',
    aliases: ['bullet', 'ul', 'list'],
    icon: List,
    description: 'Create an unordered list.',
    run: (editor) => {
      editor.chain().focus().toggleBulletList().run()
    }
  },
  {
    id: 'ordered-list',
    label: 'Numbered List',
    aliases: ['ordered', 'ol', 'numbered'],
    icon: ListOrdered,
    description: 'Create an ordered list.',
    run: (editor) => {
      editor.chain().focus().toggleOrderedList().run()
    }
  },
  {
    id: 'blockquote',
    label: 'Quote',
    aliases: ['quote', 'blockquote'],
    icon: Quote,
    description: 'Insert a blockquote.',
    run: (editor) => {
      editor.chain().focus().toggleBlockquote().run()
    }
  },
  {
    id: 'code-block',
    label: 'Code Block',
    aliases: ['code', 'snippet'],
    icon: List,
    description: 'Insert a fenced code block.',
    run: (editor) => {
      editor.chain().focus().toggleCodeBlock().run()
    }
  },
  {
    id: 'divider',
    label: 'Divider',
    aliases: ['divider', 'rule', 'hr'],
    icon: List,
    description: 'Insert a horizontal rule.',
    run: (editor) => {
      editor.chain().focus().setHorizontalRule().run()
    }
  },
  {
    id: 'image',
    label: 'Image',
    aliases: ['image', 'img'],
    icon: ImageIcon,
    description: 'Insert an image from your computer.',
    // Why: window.prompt() is not supported in Electron's renderer process,
    // so image URL input is handled by an inline input bar in RichMarkdownEditor.
    run: (editor) => {
      editor.chain().focus().run()
    }
  }
]

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
