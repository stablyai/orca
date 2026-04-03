import React from 'react'
import type { Editor } from '@tiptap/react'
import { Heading1, Heading2, Heading3, ImageIcon, List, ListOrdered, Quote } from 'lucide-react'

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
      editor.chain().focus().toggleHeading({ level: 1 }).run()
    }
  },
  {
    id: 'heading-2',
    label: 'Heading 2',
    aliases: ['h2'],
    icon: Heading2,
    description: 'Medium section heading.',
    run: (editor) => {
      editor.chain().focus().toggleHeading({ level: 2 }).run()
    }
  },
  {
    id: 'heading-3',
    label: 'Heading 3',
    aliases: ['h3'],
    icon: Heading3,
    description: 'Small section heading.',
    run: (editor) => {
      editor.chain().focus().toggleHeading({ level: 3 }).run()
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
    description: 'Insert an image from a URL.',
    run: (editor) => {
      const src = window.prompt('Image URL')
      if (!src) {
        return
      }
      editor.chain().focus().setImage({ src }).run()
    }
  }
]
