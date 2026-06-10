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
  Pilcrow,
  Quote
} from 'lucide-react'
import { RichMarkdownToolbarButton } from './RichMarkdownToolbarButton'
import { translate } from '@/i18n/i18n'

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
        active={false}
        label={translate('auto.components.editor.RichMarkdownToolbar.b462641ed2', 'Body text')}
        onClick={() => editor?.chain().focus().setParagraph().run()}
      >
        <Pilcrow className="size-3.5" />
      </RichMarkdownToolbarButton>
      <RichMarkdownToolbarButton
        active={false}
        label={translate('auto.components.editor.RichMarkdownToolbar.abb5100a3d', 'Heading 1')}
        onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}
      >
        <Heading1 className="size-3.5" />
      </RichMarkdownToolbarButton>
      <RichMarkdownToolbarButton
        active={false}
        label={translate('auto.components.editor.RichMarkdownToolbar.d34a2021c8', 'Heading 2')}
        onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
      >
        <Heading2 className="size-3.5" />
      </RichMarkdownToolbarButton>
      <RichMarkdownToolbarButton
        active={false}
        label={translate('auto.components.editor.RichMarkdownToolbar.cf5817d827', 'Heading 3')}
        onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}
      >
        <Heading3 className="size-3.5" />
      </RichMarkdownToolbarButton>
      <Separator />
      <RichMarkdownToolbarButton
        active={false}
        label={translate('auto.components.editor.RichMarkdownToolbar.4f9e789fe0', 'Bold')}
        onClick={() => editor?.chain().focus().toggleBold().run()}
      >
        B
      </RichMarkdownToolbarButton>
      <RichMarkdownToolbarButton
        active={false}
        label={translate('auto.components.editor.RichMarkdownToolbar.6b4ccf9493', 'Italic')}
        onClick={() => editor?.chain().focus().toggleItalic().run()}
      >
        I
      </RichMarkdownToolbarButton>
      <RichMarkdownToolbarButton
        active={false}
        label={translate('auto.components.editor.RichMarkdownToolbar.0bea19a988', 'Strike')}
        onClick={() => editor?.chain().focus().toggleStrike().run()}
      >
        S
      </RichMarkdownToolbarButton>
      <Separator />
      <RichMarkdownToolbarButton
        active={false}
        label={translate('auto.components.editor.RichMarkdownToolbar.5d1539e5a9', 'Bullet list')}
        onClick={() => editor?.chain().focus().toggleBulletList().run()}
      >
        <List className="size-3.5" />
      </RichMarkdownToolbarButton>
      <RichMarkdownToolbarButton
        active={false}
        label={translate('auto.components.editor.RichMarkdownToolbar.31630ed66e', 'Numbered list')}
        onClick={() => editor?.chain().focus().toggleOrderedList().run()}
      >
        <ListOrdered className="size-3.5" />
      </RichMarkdownToolbarButton>
      <RichMarkdownToolbarButton
        active={false}
        label={translate('auto.components.editor.RichMarkdownToolbar.f97031be09', 'Checklist')}
        onClick={() => editor?.chain().focus().toggleTaskList().run()}
      >
        <ListTodo className="size-3.5" />
      </RichMarkdownToolbarButton>
      <Separator />
      <RichMarkdownToolbarButton
        active={false}
        label={translate('auto.components.editor.RichMarkdownToolbar.f6a51cb9af', 'Quote')}
        onClick={() => editor?.chain().focus().toggleBlockquote().run()}
      >
        <Quote className="size-3.5" />
      </RichMarkdownToolbarButton>
      <RichMarkdownToolbarButton
        active={false}
        label={translate('auto.components.editor.RichMarkdownToolbar.6d52624712', 'Link')}
        onClick={onToggleLink}
      >
        <LinkIcon className="size-3.5" />
      </RichMarkdownToolbarButton>
      <RichMarkdownToolbarButton
        active={false}
        label={translate('auto.components.editor.RichMarkdownToolbar.e935c6b61e', 'Image')}
        onClick={onImagePick}
      >
        <ImageIcon className="size-3.5" />
      </RichMarkdownToolbarButton>
    </div>
  )
}
