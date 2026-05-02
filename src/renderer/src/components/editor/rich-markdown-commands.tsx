import React from 'react'
import type { Editor } from '@tiptap/react'
import { Heading1, Heading2, Heading3, ImageIcon, List, ListOrdered, Quote } from 'lucide-react'
import type { MarkdownDocument } from '../../../../shared/types'
import { stripMarkdownExtension } from './markdown-doc-links'

export type SlashMenuState = {
  query: string
  from: number
  to: number
  left: number
  top: number
}

export type DocLinkMenuState = {
  query: string
  // Why: `from` points at the first `[` of the `[[` trigger (not after the brackets)
  // so the commit path's deleteRange({ from, to }) removes `[[query` entirely before
  // inserting the atom node.
  from: number
  to: number
  left: number
  top: number
}

// Why: discriminated union so v2 can add non-document rows (e.g., "Create <query>")
// without refactoring the commit path. v1 only emits `document` rows.
export type DocLinkMenuRow =
  | { kind: 'document'; document: MarkdownDocument }
  | { kind: 'action'; id: string; label: string; run: (editor: Editor) => void }

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

// Why: the leading alternation `(^|[\s(])` is a mid-word guard so typing `foo[[`
// inside a word does not fire the popover — `[[` only triggers at start-of-block,
// after whitespace, or after `(`. `[^[\]|\r\n]*` bans characters that would break
// the trigger contract (nested brackets) or belong to a deferred v1 feature (`|`
// display-text override).
const DOC_LINK_TRIGGER_REGEX = /(^|[\s(])\[\[([^[\]|\r\n]*)$/

/**
 * Inserts an atom doc-link node at the trigger range. Directly creating the
 * markdownDocLink node (instead of typing `[[target]]` and relying on the
 * auto-convert plugin) keeps undo to a single step and avoids a one-tick
 * flicker where the inline preview decoration would also run.
 */
export function runDocLinkCommand(
  editor: Editor,
  menu: { from: number; to: number },
  document: MarkdownDocument
): void {
  const target = stripMarkdownExtension(document.relativePath)
  editor
    .chain()
    .focus()
    .deleteRange({ from: menu.from, to: menu.to })
    .insertContentAt(menu.from, { type: 'markdownDocLink', attrs: { target } })
    .run()
}

/**
 * Single commit entrypoint shared by click and keyboard paths. Dispatches on
 * the row kind so v2 action rows plug in without refactoring either caller.
 */
export function commitRow(editor: Editor, menu: DocLinkMenuState, row: DocLinkMenuRow): void {
  if (row.kind === 'document') {
    runDocLinkCommand(editor, menu, row.document)
    return
  }
  // Why: action rows (v2 "Create <query>") delete the trigger text and hand
  // off to their own run(). v1 never emits action rows so this branch is dead
  // today, but the shape is in place so the hook point costs nothing later.
  editor.chain().focus().deleteRange({ from: menu.from, to: menu.to }).run()
  row.run(editor)
}

/**
 * Mirror of `syncSlashMenu` for the `[[...]]` doc-link trigger. Every bail
 * path MUST call setDocLinkMenu(null) so a previously-open popover closes
 * when the cursor leaves the trigger region.
 */
export function syncDocLinkMenu(
  editor: Editor,
  root: HTMLDivElement | null,
  setDocLinkMenu: React.Dispatch<React.SetStateAction<DocLinkMenuState | null>>
): void {
  // Guard 1: not editable, IME composing, or non-empty selection.
  if (!root || editor.view.composing || !editor.isEditable) {
    setDocLinkMenu(null)
    return
  }

  const { state, view } = editor
  const { selection } = state
  if (!selection.empty) {
    setDocLinkMenu(null)
    return
  }

  // Guard 2: must be inside a textblock.
  const { $from } = selection
  if (!$from.parent.isTextblock) {
    setDocLinkMenu(null)
    return
  }

  // Guard 3: skip code contexts (fenced code, inline code mark). Inside code,
  // `[[` is literal text and must not open the popover.
  if ($from.parent.type.spec.code) {
    setDocLinkMenu(null)
    return
  }
  const codeMarkType = state.schema.marks.code
  if (codeMarkType && state.doc.rangeHasMark($from.pos, $from.pos, codeMarkType)) {
    setDocLinkMenu(null)
    return
  }

  // Guard 4/5: extract block text and match the trigger regex.
  const blockTextBeforeCursor = $from.parent.textBetween(0, $from.parentOffset, '\0', '\0')
  const match = blockTextBeforeCursor.match(DOC_LINK_TRIGGER_REGEX)
  if (!match) {
    setDocLinkMenu(null)
    return
  }

  // Why: use lastIndexOf('[[') for the `from` position because match.index points
  // at the boundary char captured by group 1 (whitespace/`(`), not at the first
  // `[`. Using match.index directly would make deleteRange({ from, to }) also
  // eat the preceding whitespace/paren. `[[` cannot appear inside capture group 2
  // (the negated class excludes `[`), so lastIndexOf is unambiguous.
  const bracketOffset = blockTextBeforeCursor.lastIndexOf('[[')
  const from = selection.from - ($from.parentOffset - bracketOffset)

  const coords = view.coordsAtPos(selection.from)
  const rect = root.getBoundingClientRect()

  setDocLinkMenu({
    query: match[2] ?? '',
    from,
    to: selection.from,
    left: coords.left - rect.left,
    top: coords.bottom - rect.top + 8
  })
}
