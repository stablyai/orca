import React from 'react'
import type { Editor } from '@tiptap/react'
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
  return (
    <div className="rich-markdown-editor-toolbar">
      <RichMarkdownToolbarButton
        active={editor?.isActive('heading', { level: 1 }) ?? false}
        label="Heading 1"
        onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}
      >
        <Heading1 className="size-3.5" />
      </RichMarkdownToolbarButton>
      <RichMarkdownToolbarButton
        active={editor?.isActive('heading', { level: 2 }) ?? false}
        label="Heading 2"
        onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
      >
        <Heading2 className="size-3.5" />
      </RichMarkdownToolbarButton>
      <RichMarkdownToolbarButton
        active={editor?.isActive('heading', { level: 3 }) ?? false}
        label="Heading 3"
        onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}
      >
        <Heading3 className="size-3.5" />
      </RichMarkdownToolbarButton>
      <Separator />
      <RichMarkdownToolbarButton
        active={editor?.isActive('bold') ?? false}
        label="Bold"
        onClick={() => editor?.chain().focus().toggleBold().run()}
      >
        B
      </RichMarkdownToolbarButton>
      <RichMarkdownToolbarButton
        active={editor?.isActive('italic') ?? false}
        label="Italic"
        onClick={() => editor?.chain().focus().toggleItalic().run()}
      >
        I
      </RichMarkdownToolbarButton>
      <RichMarkdownToolbarButton
        active={editor?.isActive('strike') ?? false}
        label="Strike"
        onClick={() => editor?.chain().focus().toggleStrike().run()}
      >
        S
      </RichMarkdownToolbarButton>
      <Separator />
      <RichMarkdownToolbarButton
        active={editor?.isActive('bulletList') ?? false}
        label="Bullet list"
        onClick={() => editor?.chain().focus().toggleBulletList().run()}
      >
        <List className="size-3.5" />
      </RichMarkdownToolbarButton>
      <RichMarkdownToolbarButton
        active={editor?.isActive('orderedList') ?? false}
        label="Numbered list"
        onClick={() => editor?.chain().focus().toggleOrderedList().run()}
      >
        <ListOrdered className="size-3.5" />
      </RichMarkdownToolbarButton>
      <RichMarkdownToolbarButton
        active={editor?.isActive('taskList') ?? false}
        label="Checklist"
        onClick={() => editor?.chain().focus().toggleTaskList().run()}
      >
        <ListTodo className="size-3.5" />
      </RichMarkdownToolbarButton>
      <Separator />
      <RichMarkdownToolbarButton
        active={editor?.isActive('blockquote') ?? false}
        label="Quote"
        onClick={() => editor?.chain().focus().toggleBlockquote().run()}
      >
        <Quote className="size-3.5" />
      </RichMarkdownToolbarButton>
      <RichMarkdownToolbarButton
        active={editor?.isActive('link') ?? false}
        label="Link"
        onClick={onToggleLink}
      >
        <LinkIcon className="size-3.5" />
      </RichMarkdownToolbarButton>
      <RichMarkdownToolbarButton active={false} label="Image" onClick={onImagePick}>
        <ImageIcon className="size-3.5" />
      </RichMarkdownToolbarButton>
    </div>
  )
}
