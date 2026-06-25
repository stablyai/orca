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

import {
  icon,
  insertCodeBlock,
  insertTextWithSelection,
  insertToggle,
  textIcon,
  type SlashCommand
} from './rich-markdown-slash-command-primitives'

export type {
  SlashCommand,
  SlashCommandGroup,
  SlashCommandIcon,
  SlashCommandId,
  SlashMenuState
} from './rich-markdown-slash-command-primitives'

export const slashCommands: SlashCommand[] = [
  {
    id: 'heading-1',
    get label() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.e66e7f04c6',
        'Heading 1'
      )
    },
    aliases: ['h1', 'title'],
    icon: icon(Heading1),
    group: 'Headings',
    get description() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.570611864e',
        'Large section heading.'
      )
    },
    run: (editor) => {
      // Use setHeading (not toggleHeading) so the slash command is idempotent —
      // invoking "/h1" on an existing H1 should keep it as H1, not revert to paragraph.
      editor.chain().focus().setHeading({ level: 1 }).run()
    }
  },
  {
    id: 'toggle-h1',
    get label() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.41482b15ce',
        'Toggle Heading 1'
      )
    },
    aliases: ['toggle-h1', 'toggle heading', 'details heading', 'collapse heading'],
    icon: icon(ChevronRight),
    group: 'Headings',
    get description() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.3294a2c0cc',
        'Create a collapsible section with a large heading summary.'
      )
    },
    run: (editor) => {
      insertToggle(editor, 'heading-1')
    }
  },
  {
    id: 'heading-2',
    get label() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.c209a116b7',
        'Heading 2'
      )
    },
    aliases: ['h2'],
    icon: icon(Heading2),
    group: 'Headings',
    get description() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.45cf7ceb3f',
        'Medium section heading.'
      )
    },
    run: (editor) => {
      // Use setHeading (not toggleHeading) so the slash command is idempotent —
      // invoking "/h2" on an existing H2 should keep it as H2, not revert to paragraph.
      editor.chain().focus().setHeading({ level: 2 }).run()
    }
  },
  {
    id: 'heading-3',
    get label() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.30566ee962',
        'Heading 3'
      )
    },
    aliases: ['h3'],
    icon: icon(Heading3),
    group: 'Headings',
    get description() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.4920740259',
        'Small section heading.'
      )
    },
    run: (editor) => {
      // Use setHeading (not toggleHeading) so the slash command is idempotent —
      // invoking "/h3" on an existing H3 should keep it as H3, not revert to paragraph.
      editor.chain().focus().setHeading({ level: 3 }).run()
    }
  },
  {
    id: 'blockquote',
    get label() {
      return translate('auto.components.editor.rich.markdown.slash.commands.c4c775778b', 'Quote')
    },
    aliases: ['quote', 'blockquote'],
    icon: icon(Quote),
    group: 'Basic blocks',
    get description() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.6a3def14de',
        'Insert a blockquote.'
      )
    },
    run: (editor) => {
      editor.chain().focus().toggleBlockquote().run()
    }
  },
  {
    id: 'ordered-list',
    get label() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.ed4cf0ebce',
        'Numbered List'
      )
    },
    aliases: ['ordered', 'ol', 'numbered'],
    icon: icon(ListOrdered),
    group: 'Basic blocks',
    get description() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.8e00aba296',
        'Create an ordered list.'
      )
    },
    run: (editor) => {
      editor.chain().focus().toggleOrderedList().run()
    }
  },
  {
    id: 'bullet-list',
    get label() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.56ff3237e7',
        'Bullet List'
      )
    },
    aliases: ['bullet', 'ul', 'list'],
    icon: icon(List),
    group: 'Basic blocks',
    get description() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.c9b9e826b8',
        'Create an unordered list.'
      )
    },
    run: (editor) => {
      editor.chain().focus().toggleBulletList().run()
    }
  },
  {
    id: 'task-list',
    get label() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.d0d2cdfbdb',
        'Check List'
      )
    },
    aliases: ['todo', 'task', 'checkbox'],
    icon: icon(List),
    group: 'Basic blocks',
    get description() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.d766f44867',
        'Create a checklist.'
      )
    },
    run: (editor) => {
      editor.chain().focus().toggleTaskList().run()
    }
  },
  {
    id: 'text',
    get label() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.58abdb9d41',
        'Paragraph'
      )
    },
    aliases: ['paragraph', 'plain'],
    icon: icon(List),
    group: 'Basic blocks',
    get description() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.9a7fe896dc',
        'Start a normal paragraph.'
      )
    },
    run: (editor) => {
      editor.chain().focus().setParagraph().run()
    }
  },
  {
    id: 'toggle-text',
    get label() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.f82c78a2ee',
        'Toggle Text'
      )
    },
    aliases: ['toggle', 'details', 'collapse', 'toggle-text'],
    icon: icon(ChevronRight),
    group: 'Basic blocks',
    get description() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.972ef9aeea',
        'Create a collapsible text section.'
      )
    },
    run: (editor) => {
      insertToggle(editor)
    }
  },
  {
    id: 'code-block',
    get label() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.624b50cf25',
        'Code Block'
      )
    },
    aliases: ['code', 'snippet'],
    icon: icon(List),
    group: 'Basic blocks',
    get description() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.89e327e054',
        'Insert a fenced code block.'
      )
    },
    run: (editor) => {
      editor.chain().focus().toggleCodeBlock().run()
    }
  },
  {
    id: 'divider',
    get label() {
      return translate('auto.components.editor.rich.markdown.slash.commands.ae8377cf6b', 'Divider')
    },
    aliases: ['divider', 'rule', 'hr'],
    icon: icon(List),
    group: 'Basic blocks',
    get description() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.fae45ef4d3',
        'Insert a horizontal rule.'
      )
    },
    run: (editor) => {
      editor.chain().focus().setHorizontalRule().run()
    }
  },
  {
    id: 'table',
    get label() {
      return translate('auto.components.editor.rich.markdown.slash.commands.19ea597868', 'Table')
    },
    aliases: ['grid', 'columns', 'rows'],
    icon: icon(Table2),
    group: 'Advanced',
    get description() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.67faab829b',
        'Insert a 3x3 markdown table.'
      )
    },
    run: (editor) => {
      editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
    }
  },
  {
    id: 'mermaid',
    get label() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.e516d3f6e3',
        'Mermaid Diagram'
      )
    },
    aliases: ['diagram', 'flowchart', 'chart', 'graph'],
    icon: icon(Workflow),
    group: 'Advanced',
    get description() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.0ed9a7b38c',
        'Insert a Mermaid fenced block.'
      )
    },
    run: (editor) => {
      insertCodeBlock(editor, 'mermaid', 'graph TD\n  A[Start] --> B[End]')
    }
  },
  {
    id: 'inline-math',
    get label() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.2bf5544faf',
        'Inline Math'
      )
    },
    aliases: ['math', 'latex', 'equation', 'formula'],
    icon: icon(Sigma),
    group: 'Advanced',
    get description() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.565907cf7a',
        'Insert inline LaTeX math.'
      )
    },
    run: (editor) => {
      editor.commands.insertInlineMath({ latex: 'x' })
    }
  },
  {
    id: 'math-block',
    get label() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.6993a38ad1',
        'Math Block'
      )
    },
    aliases: ['display math', 'latex block', 'equation block'],
    icon: icon(Sigma),
    group: 'Advanced',
    get description() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.ae7d0f3f37',
        'Insert display LaTeX math.'
      )
    },
    run: (editor) => {
      editor.commands.insertBlockMath({ latex: 'x' })
    }
  },
  {
    id: 'image',
    get label() {
      return translate('auto.components.editor.rich.markdown.slash.commands.572be8e524', 'Image')
    },
    aliases: ['image', 'img'],
    icon: icon(ImageIcon),
    group: 'Media',
    get description() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.3324eb391a',
        'Insert an image from your computer.'
      )
    },
    // Why: window.prompt() is not supported in Electron's renderer process,
    // so image URL input is handled by an inline input bar in RichMarkdownEditor.
    run: (editor) => {
      editor.chain().focus().run()
    }
  },
  {
    id: 'emoji',
    get label() {
      return translate('auto.components.editor.rich.markdown.slash.commands.8a30cbaeca', 'Emoji')
    },
    aliases: ['smile', 'reaction', 'icon'],
    icon: textIcon('🙂'),
    group: 'Others',
    get description() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.07e1b32396',
        'Insert a plain Unicode emoji.'
      )
    },
    run: (editor) => {
      insertTextWithSelection(editor, '🙂')
    }
  }
]
