import React from 'react'
import type { Editor } from '@tiptap/react'
import { useEditorState } from '@tiptap/react'
import {
  Heading1,
  Heading2,
  Heading3,
  ImageIcon,
  Link as LinkIcon,
  List,
  ListOrdered,
  ListTodo,
  Quote
} from 'lucide-react'
import { RichMarkdownToolbarButton } from './RichMarkdownToolbarButton'

type RichMarkdownToolbarProps = {
  editor: Editor | null
  onToggleLink: () => void
  onImagePick: () => void
}

function Separator(): React.JSX.Element {
  return <div className="rich-markdown-toolbar-separator" />
}

export function RichMarkdownToolbar({
  editor,
  onToggleLink,
  onImagePick
}: RichMarkdownToolbarProps): React.JSX.Element {
  // Why: the editor object reference is stable across transactions, so passing
  // it as a prop alone won't re-render this component when the selection moves.
  // useEditorState subscribes to editor transactions and returns derived state,
  // triggering a re-render only when the active formatting actually changes.
  const active = useEditorState({
    editor,
    selector: (ctx) => {
      const ed = ctx.editor
      if (!ed) {
        return null
      }
      return {
        h1: ed.isActive('heading', { level: 1 }),
        h2: ed.isActive('heading', { level: 2 }),
        h3: ed.isActive('heading', { level: 3 }),
        bold: ed.isActive('bold'),
        italic: ed.isActive('italic'),
        strike: ed.isActive('strike'),
        bulletList: ed.isActive('bulletList'),
        orderedList: ed.isActive('orderedList'),
        taskList: ed.isActive('taskList'),
        blockquote: ed.isActive('blockquote'),
        link: ed.isActive('link')
      }
    }
  })

  return (
    <div className="rich-markdown-editor-toolbar">
      <RichMarkdownToolbarButton
        active={active?.h1 ?? false}
        label="Heading 1"
        onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}
      >
        <Heading1 className="size-3.5" />
      </RichMarkdownToolbarButton>
      <RichMarkdownToolbarButton
        active={active?.h2 ?? false}
        label="Heading 2"
        onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
      >
        <Heading2 className="size-3.5" />
      </RichMarkdownToolbarButton>
      <RichMarkdownToolbarButton
        active={active?.h3 ?? false}
        label="Heading 3"
        onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}
      >
        <Heading3 className="size-3.5" />
      </RichMarkdownToolbarButton>
      <Separator />
      <RichMarkdownToolbarButton
        active={active?.bold ?? false}
        label="Bold"
        onClick={() => editor?.chain().focus().toggleBold().run()}
      >
        B
      </RichMarkdownToolbarButton>
      <RichMarkdownToolbarButton
        active={active?.italic ?? false}
        label="Italic"
        onClick={() => editor?.chain().focus().toggleItalic().run()}
      >
        I
      </RichMarkdownToolbarButton>
      <RichMarkdownToolbarButton
        active={active?.strike ?? false}
        label="Strike"
        onClick={() => editor?.chain().focus().toggleStrike().run()}
      >
        S
      </RichMarkdownToolbarButton>
      <Separator />
      <RichMarkdownToolbarButton
        active={active?.bulletList ?? false}
        label="Bullet list"
        onClick={() => editor?.chain().focus().toggleBulletList().run()}
      >
        <List className="size-3.5" />
      </RichMarkdownToolbarButton>
      <RichMarkdownToolbarButton
        active={active?.orderedList ?? false}
        label="Numbered list"
        onClick={() => editor?.chain().focus().toggleOrderedList().run()}
      >
        <ListOrdered className="size-3.5" />
      </RichMarkdownToolbarButton>
      <RichMarkdownToolbarButton
        active={active?.taskList ?? false}
        label="Checklist"
        onClick={() => editor?.chain().focus().toggleTaskList().run()}
      >
        <ListTodo className="size-3.5" />
      </RichMarkdownToolbarButton>
      <Separator />
      <RichMarkdownToolbarButton
        active={active?.blockquote ?? false}
        label="Quote"
        onClick={() => editor?.chain().focus().toggleBlockquote().run()}
      >
        <Quote className="size-3.5" />
      </RichMarkdownToolbarButton>
      <RichMarkdownToolbarButton active={active?.link ?? false} label="Link" onClick={onToggleLink}>
        <LinkIcon className="size-3.5" />
      </RichMarkdownToolbarButton>
      <RichMarkdownToolbarButton active={false} label="Image" onClick={onImagePick}>
        <ImageIcon className="size-3.5" />
      </RichMarkdownToolbarButton>
    </div>
  )
}
