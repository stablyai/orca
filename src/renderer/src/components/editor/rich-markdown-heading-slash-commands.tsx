import { ChevronRight, Heading1, Heading2, Heading3, Heading4, Heading5 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { icon, insertToggle, type SlashCommand } from './rich-markdown-slash-command-primitives'

export const headingSlashCommands: SlashCommand[] = [
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
      // Use setHeading (not toggleHeading) so "/h1" is idempotent.
      editor.chain().focus().setHeading({ level: 1 }).run()
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
      // Use setHeading (not toggleHeading) so "/h2" is idempotent.
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
      // Use setHeading (not toggleHeading) so "/h3" is idempotent.
      editor.chain().focus().setHeading({ level: 3 }).run()
    }
  },
  {
    id: 'heading-4',
    get label() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.5f9a0ed7c4',
        'Heading 4'
      )
    },
    aliases: ['h4'],
    icon: icon(Heading4),
    group: 'Headings',
    get description() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.01a71dbbdd',
        'Nested section heading.'
      )
    },
    run: (editor) => {
      // Use setHeading (not toggleHeading) so "/h4" is idempotent.
      editor.chain().focus().setHeading({ level: 4 }).run()
    }
  },
  {
    id: 'heading-5',
    get label() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.8440fa4acf',
        'Heading 5'
      )
    },
    aliases: ['h5'],
    icon: icon(Heading5),
    group: 'Headings',
    get description() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.b287b93c66',
        'Deep section heading.'
      )
    },
    run: (editor) => {
      // Use setHeading (not toggleHeading) so "/h5" is idempotent.
      editor.chain().focus().setHeading({ level: 5 }).run()
    }
  },
  // Grouped separately (Notion-style) so plain headings and collapsible
  // toggle headings are easy to scan as distinct families in the slash menu.
  {
    id: 'toggle-h1',
    get label() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.41482b15ce',
        'Toggle H1'
      )
    },
    aliases: ['toggle-h1', 'toggle heading', 'details heading', 'collapse heading'],
    icon: icon(ChevronRight),
    group: 'Toggle headings',
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
    id: 'toggle-h2',
    get label() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.7a2c1f9b04',
        'Toggle H2'
      )
    },
    aliases: ['toggle-h2'],
    icon: icon(ChevronRight),
    group: 'Toggle headings',
    get description() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.b3e5d8a1c6',
        'Create a collapsible section with a medium heading summary.'
      )
    },
    run: (editor) => {
      insertToggle(editor, 'heading-2')
    }
  },
  {
    id: 'toggle-h3',
    get label() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.2f9d6b4e10',
        'Toggle H3'
      )
    },
    aliases: ['toggle-h3'],
    icon: icon(ChevronRight),
    group: 'Toggle headings',
    get description() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.8c1a3e7d52',
        'Create a collapsible section with a small heading summary.'
      )
    },
    run: (editor) => {
      insertToggle(editor, 'heading-3')
    }
  },
  {
    id: 'toggle-h4',
    get label() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.5e0b9c2a71',
        'Toggle H4'
      )
    },
    aliases: ['toggle-h4'],
    icon: icon(ChevronRight),
    group: 'Toggle headings',
    get description() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.d4f16a8b39',
        'Create a collapsible section with a nested heading summary.'
      )
    },
    run: (editor) => {
      insertToggle(editor, 'heading-4')
    }
  },
  {
    id: 'toggle-h5',
    get label() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.21d8c463e5',
        'Toggle H5'
      )
    },
    aliases: ['toggle-h5'],
    icon: icon(ChevronRight),
    group: 'Toggle headings',
    get description() {
      return translate(
        'auto.components.editor.rich.markdown.slash.commands.dc239b41ad',
        'Create a collapsible section with a deep heading summary.'
      )
    },
    run: (editor) => {
      insertToggle(editor, 'heading-5')
    }
  }
]
