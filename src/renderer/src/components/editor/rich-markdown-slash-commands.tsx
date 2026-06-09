import type React from 'react'
import type { Editor } from '@tiptap/react'
import { TextSelection } from '@tiptap/pm/state'
import type {} from '@tiptap/extension-mathematics'
import {
  ChevronRight,
  Heading1,
  Heading2,
  Heading3,
  ImageIcon,
  List,
  ListOrdered,
  Quote,
  Sigma,
  Table2,
  Workflow
} from 'lucide-react'
import { translate } from '@/i18n/i18n'

export type SlashMenuState = {
  query: string
  from: number
  to: number
  left: number
  top: number
}

export type SlashCommandId =
  | 'text'
  | 'toggle-text'
  | 'heading-1'
  | 'toggle-h1'
  | 'heading-2'
  | 'heading-3'
  | 'task-list'
  | 'bullet-list'
  | 'ordered-list'
  | 'blockquote'
  | 'code-block'
  | 'divider'
  | 'image'
  | 'table'
  | 'mermaid'
  | 'inline-math'
  | 'math-block'
  | 'emoji'

export type SlashCommandIcon =
  | { kind: 'component'; component: React.ComponentType<{ className?: string }> }
  | { kind: 'text'; value: string }

export type SlashCommandGroup = 'Headings' | 'Basic blocks' | 'Advanced' | 'Media' | 'Others'

export type SlashCommand = {
  id: SlashCommandId
  label: string
  aliases: string[]
  icon: SlashCommandIcon
  group: SlashCommandGroup
  description: string
  run: (editor: Editor) => void
}

function icon(component: React.ComponentType<{ className?: string }>): SlashCommandIcon {
  return { kind: 'component', component }
}

function textIcon(value: string): SlashCommandIcon {
  return { kind: 'text', value }
}

function insertTextWithSelection(
  editor: Editor,
  text: string,
  selectionStartOffset?: number,
  selectionEndOffset = selectionStartOffset
): void {
  editor.commands.command(({ state, dispatch }) => {
    const from = state.selection.from
    const tr = state.tr.insertText(text, from, state.selection.to)

    if (selectionStartOffset !== undefined) {
      const selectionFrom = from + selectionStartOffset
      const selectionTo = from + (selectionEndOffset ?? selectionStartOffset)
      tr.setSelection(TextSelection.create(tr.doc, selectionFrom, selectionTo))
    }

    dispatch?.(tr.scrollIntoView())
    return true
  })
}

function insertCodeBlock(editor: Editor, language: string, text: string): void {
  editor.commands.command(({ state, dispatch }) => {
    const codeBlockType = state.schema.nodes.codeBlock
    if (!codeBlockType) {
      return false
    }
    const node = codeBlockType.create({ language }, text ? state.schema.text(text) : undefined)
    const tr = state.tr.replaceSelectionWith(node).scrollIntoView()
    const cursor = tr.selection.from + 1
    tr.setSelection(TextSelection.create(tr.doc, cursor, cursor))
    dispatch?.(tr)
    return true
  })
}

function insertToggle(editor: Editor, variant?: 'heading-1'): void {
  const insertAt = editor.state.selection.from

  editor
    .chain()
    .focus()
    .insertContentAt(insertAt, {
      type: 'details',
      attrs: {
        open: true,
        ...(variant ? { variant } : {})
      },
      content: [
        {
          type: 'detailsSummary'
        },
        {
          type: 'detailsContent',
          content: [{ type: 'paragraph' }]
        }
      ]
    })
    .setTextSelection(insertAt + 1)
    .run()
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

export const slashCommands: SlashCommand[] = [
  {
    id: 'heading-1',
    label: translate("auto.components.editor.rich.markdown.slash.commands.e66e7f04c6", "Heading 1"),
    aliases: ['h1', 'title'],
    icon: icon(Heading1),
    group: 'Headings',
    description: translate("auto.components.editor.rich.markdown.slash.commands.570611864e", "Large section heading."),
    run: (editor) => {
      // Use setHeading (not toggleHeading) so the slash command is idempotent —
      // invoking "/h1" on an existing H1 should keep it as H1, not revert to paragraph.
      editor.chain().focus().setHeading({ level: 1 }).run()
    }
  },
  {
    id: 'toggle-h1',
    label: translate("auto.components.editor.rich.markdown.slash.commands.41482b15ce", "Toggle Heading 1"),
    aliases: ['toggle-h1', 'toggle heading', 'details heading', 'collapse heading'],
    icon: icon(ChevronRight),
    group: 'Headings',
    description: translate("auto.components.editor.rich.markdown.slash.commands.3294a2c0cc", "Create a collapsible section with a large heading summary."),
    run: (editor) => {
      insertToggle(editor, 'heading-1')
    }
  },
  {
    id: 'heading-2',
    label: translate("auto.components.editor.rich.markdown.slash.commands.c209a116b7", "Heading 2"),
    aliases: ['h2'],
    icon: icon(Heading2),
    group: 'Headings',
    description: translate("auto.components.editor.rich.markdown.slash.commands.45cf7ceb3f", "Medium section heading."),
    run: (editor) => {
      // Use setHeading (not toggleHeading) so the slash command is idempotent —
      // invoking "/h2" on an existing H2 should keep it as H2, not revert to paragraph.
      editor.chain().focus().setHeading({ level: 2 }).run()
    }
  },
  {
    id: 'heading-3',
    label: translate("auto.components.editor.rich.markdown.slash.commands.30566ee962", "Heading 3"),
    aliases: ['h3'],
    icon: icon(Heading3),
    group: 'Headings',
    description: translate("auto.components.editor.rich.markdown.slash.commands.4920740259", "Small section heading."),
    run: (editor) => {
      // Use setHeading (not toggleHeading) so the slash command is idempotent —
      // invoking "/h3" on an existing H3 should keep it as H3, not revert to paragraph.
      editor.chain().focus().setHeading({ level: 3 }).run()
    }
  },
  {
    id: 'blockquote',
    label: translate("auto.components.editor.rich.markdown.slash.commands.c4c775778b", "Quote"),
    aliases: ['quote', 'blockquote'],
    icon: icon(Quote),
    group: 'Basic blocks',
    description: translate("auto.components.editor.rich.markdown.slash.commands.6a3def14de", "Insert a blockquote."),
    run: (editor) => {
      editor.chain().focus().toggleBlockquote().run()
    }
  },
  {
    id: 'ordered-list',
    label: translate("auto.components.editor.rich.markdown.slash.commands.ed4cf0ebce", "Numbered List"),
    aliases: ['ordered', 'ol', 'numbered'],
    icon: icon(ListOrdered),
    group: 'Basic blocks',
    description: translate("auto.components.editor.rich.markdown.slash.commands.8e00aba296", "Create an ordered list."),
    run: (editor) => {
      editor.chain().focus().toggleOrderedList().run()
    }
  },
  {
    id: 'bullet-list',
    label: translate("auto.components.editor.rich.markdown.slash.commands.56ff3237e7", "Bullet List"),
    aliases: ['bullet', 'ul', 'list'],
    icon: icon(List),
    group: 'Basic blocks',
    description: translate("auto.components.editor.rich.markdown.slash.commands.c9b9e826b8", "Create an unordered list."),
    run: (editor) => {
      editor.chain().focus().toggleBulletList().run()
    }
  },
  {
    id: 'task-list',
    label: translate("auto.components.editor.rich.markdown.slash.commands.d0d2cdfbdb", "Check List"),
    aliases: ['todo', 'task', 'checkbox'],
    icon: icon(List),
    group: 'Basic blocks',
    description: translate("auto.components.editor.rich.markdown.slash.commands.d766f44867", "Create a checklist."),
    run: (editor) => {
      editor.chain().focus().toggleTaskList().run()
    }
  },
  {
    id: 'text',
    label: translate("auto.components.editor.rich.markdown.slash.commands.58abdb9d41", "Paragraph"),
    aliases: ['paragraph', 'plain'],
    icon: icon(List),
    group: 'Basic blocks',
    description: translate("auto.components.editor.rich.markdown.slash.commands.9a7fe896dc", "Start a normal paragraph."),
    run: (editor) => {
      editor.chain().focus().setParagraph().run()
    }
  },
  {
    id: 'toggle-text',
    label: translate("auto.components.editor.rich.markdown.slash.commands.f82c78a2ee", "Toggle Text"),
    aliases: ['toggle', 'details', 'collapse', 'toggle-text'],
    icon: icon(ChevronRight),
    group: 'Basic blocks',
    description: translate("auto.components.editor.rich.markdown.slash.commands.972ef9aeea", "Create a collapsible text section."),
    run: (editor) => {
      insertToggle(editor)
    }
  },
  {
    id: 'code-block',
    label: translate("auto.components.editor.rich.markdown.slash.commands.624b50cf25", "Code Block"),
    aliases: ['code', 'snippet'],
    icon: icon(List),
    group: 'Basic blocks',
    description: translate("auto.components.editor.rich.markdown.slash.commands.89e327e054", "Insert a fenced code block."),
    run: (editor) => {
      editor.chain().focus().toggleCodeBlock().run()
    }
  },
  {
    id: 'divider',
    label: translate("auto.components.editor.rich.markdown.slash.commands.ae8377cf6b", "Divider"),
    aliases: ['divider', 'rule', 'hr'],
    icon: icon(List),
    group: 'Basic blocks',
    description: translate("auto.components.editor.rich.markdown.slash.commands.fae45ef4d3", "Insert a horizontal rule."),
    run: (editor) => {
      editor.chain().focus().setHorizontalRule().run()
    }
  },
  {
    id: 'table',
    label: translate("auto.components.editor.rich.markdown.slash.commands.19ea597868", "Table"),
    aliases: ['grid', 'columns', 'rows'],
    icon: icon(Table2),
    group: 'Advanced',
    description: translate("auto.components.editor.rich.markdown.slash.commands.67faab829b", "Insert a 3x3 markdown table."),
    run: (editor) => {
      editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
    }
  },
  {
    id: 'mermaid',
    label: translate("auto.components.editor.rich.markdown.slash.commands.e516d3f6e3", "Mermaid Diagram"),
    aliases: ['diagram', 'flowchart', 'chart', 'graph'],
    icon: icon(Workflow),
    group: 'Advanced',
    description: translate("auto.components.editor.rich.markdown.slash.commands.0ed9a7b38c", "Insert a Mermaid fenced block."),
    run: (editor) => {
      insertCodeBlock(editor, 'mermaid', 'graph TD\n  A[Start] --> B[End]')
    }
  },
  {
    id: 'inline-math',
    label: translate("auto.components.editor.rich.markdown.slash.commands.2bf5544faf", "Inline Math"),
    aliases: ['math', 'latex', 'equation', 'formula'],
    icon: icon(Sigma),
    group: 'Advanced',
    description: translate("auto.components.editor.rich.markdown.slash.commands.565907cf7a", "Insert inline LaTeX math."),
    run: (editor) => {
      editor.commands.insertInlineMath({ latex: 'x' })
    }
  },
  {
    id: 'math-block',
    label: translate("auto.components.editor.rich.markdown.slash.commands.6993a38ad1", "Math Block"),
    aliases: ['display math', 'latex block', 'equation block'],
    icon: icon(Sigma),
    group: 'Advanced',
    description: translate("auto.components.editor.rich.markdown.slash.commands.ae7d0f3f37", "Insert display LaTeX math."),
    run: (editor) => {
      editor.commands.insertBlockMath({ latex: 'x' })
    }
  },
  {
    id: 'image',
    label: translate("auto.components.editor.rich.markdown.slash.commands.572be8e524", "Image"),
    aliases: ['image', 'img'],
    icon: icon(ImageIcon),
    group: 'Media',
    description: translate("auto.components.editor.rich.markdown.slash.commands.3324eb391a", "Insert an image from your computer."),
    // Why: window.prompt() is not supported in Electron's renderer process,
    // so image URL input is handled by an inline input bar in RichMarkdownEditor.
    run: (editor) => {
      editor.chain().focus().run()
    }
  },
  {
    id: 'emoji',
    label: translate("auto.components.editor.rich.markdown.slash.commands.8a30cbaeca", "Emoji"),
    aliases: ['smile', 'reaction', 'icon'],
    icon: textIcon('🙂'),
    group: 'Others',
    description: translate("auto.components.editor.rich.markdown.slash.commands.07e1b32396", "Insert a plain Unicode emoji."),
    run: (editor) => {
      insertTextWithSelection(editor, '🙂')
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
