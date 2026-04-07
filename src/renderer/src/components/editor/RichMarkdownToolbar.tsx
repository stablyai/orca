import React from 'react'
import type { Editor } from '@tiptap/react'
import { ImageIcon, Link as LinkIcon, List, ListOrdered, Quote } from 'lucide-react'
import { RichMarkdownToolbarButton } from './RichMarkdownToolbarButton'

type RichMarkdownToolbarProps = {
  editor: Editor | null
  onToggleLink: () => void
  onImagePick: () => void
}

export function RichMarkdownToolbar({
  editor,
  onToggleLink,
  onImagePick
}: RichMarkdownToolbarProps): React.JSX.Element {
  return (
    <div className="rich-markdown-editor-toolbar">
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
