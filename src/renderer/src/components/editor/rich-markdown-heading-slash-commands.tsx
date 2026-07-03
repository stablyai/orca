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
  }
]
