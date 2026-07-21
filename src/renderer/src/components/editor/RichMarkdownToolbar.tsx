import React from 'react'
import type { Editor } from '@tiptap/react'
import {
  ChevronRight,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  ImageIcon,
  Link as LinkIcon,
  List,
  ListOrdered,
  ListTodo,
  MoreHorizontal,
  Pilcrow,
  Quote
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { RichMarkdownToolbarButton } from './RichMarkdownToolbarButton'
import { translate } from '@/i18n/i18n'
import { insertToggle } from './rich-markdown-slash-command-primitives'
import { formatKeybinding } from '../../../../shared/keybindings'
import { getShortcutPlatform } from '@/lib/shortcut-platform'

function getFixedShortcutLabel(binding: string, platform: NodeJS.Platform): string {
  const keys = formatKeybinding(binding, platform)
  return platform === 'darwin' ? keys.join('') : keys.join('+')
}

type RichMarkdownToolbarProps = {
  editor: Editor | null
  onToggleLink: () => void
  onImagePick: () => void
}

function Separator(): React.JSX.Element {
  return <div className="rich-markdown-toolbar-separator" />
}

function RichMarkdownMoreBlocksMenu({ editor }: { editor: Editor | null }): React.JSX.Element {
  const label = translate('auto.components.editor.RichMarkdownToolbar.91a843fb43', 'More blocks')
  const platform = getShortcutPlatform()
  const h4ShortcutLabel = getFixedShortcutLabel('Mod+Alt+4', platform)
  const h5ShortcutLabel = getFixedShortcutLabel('Mod+Alt+5', platform)

  return (
    <DropdownMenu>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="rich-markdown-toolbar-button"
                aria-label={label}
                onMouseDown={(event) => event.preventDefault()}
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            {label}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DropdownMenuContent align="end" side="bottom">
        <DropdownMenuLabel>
          {translate('auto.components.editor.RichMarkdownToolbar.2cd9e0bbb3', 'Headings')}
        </DropdownMenuLabel>
        <DropdownMenuItem
          onSelect={() => editor?.chain().focus().toggleHeading({ level: 4 }).run()}
        >
          <Heading4 className="size-3.5" />
          {translate('auto.components.editor.RichMarkdownToolbar.b05e14620d', 'Heading 4')}
          <DropdownMenuShortcut>{h4ShortcutLabel}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => editor?.chain().focus().toggleHeading({ level: 5 }).run()}
        >
          <Heading5 className="size-3.5" />
          {translate('auto.components.editor.RichMarkdownToolbar.6bbf827ef5', 'Heading 5')}
          <DropdownMenuShortcut>{h5ShortcutLabel}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => (editor ? insertToggle(editor) : undefined)}>
          <ChevronRight className="size-3.5" />
          {translate(
            'auto.components.editor.RichMarkdownToolbar.d1bbf9a835',
            'Collapsible section'
          )}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function RichMarkdownToolbar({
  editor,
  onToggleLink,
  onImagePick
}: RichMarkdownToolbarProps): React.JSX.Element {
  const platform = getShortcutPlatform()
  const boldShortcut = { keys: formatKeybinding('Mod+B', platform), doubleTap: false }
  const italicShortcut = { keys: formatKeybinding('Mod+I', platform), doubleTap: false }
  const strikeShortcut = { keys: formatKeybinding('Mod+Shift+X', platform), doubleTap: false }
  const bulletListShortcut = { keys: formatKeybinding('Mod+Shift+8', platform), doubleTap: false }
  const orderedListShortcut = { keys: formatKeybinding('Mod+Shift+7', platform), doubleTap: false }
  const blockquoteShortcut = { keys: formatKeybinding('Mod+Shift+B', platform), doubleTap: false }
  const h1Shortcut = { keys: formatKeybinding('Mod+Alt+1', platform), doubleTap: false }
  const h2Shortcut = { keys: formatKeybinding('Mod+Alt+2', platform), doubleTap: false }
  const h3Shortcut = { keys: formatKeybinding('Mod+Alt+3', platform), doubleTap: false }
  const paragraphShortcut = { keys: formatKeybinding('Mod+Alt+0', platform), doubleTap: false }

  return (
    <div className="rich-markdown-editor-toolbar">
      <RichMarkdownToolbarButton
        active={false}
        label={translate('auto.components.editor.RichMarkdownToolbar.b462641ed2', 'Body text')}
        onClick={() => editor?.chain().focus().setParagraph().run()}
        shortcut={paragraphShortcut}
      >
        <Pilcrow className="size-3.5" />
      </RichMarkdownToolbarButton>
      <RichMarkdownToolbarButton
        active={false}
        label={translate('auto.components.editor.RichMarkdownToolbar.abb5100a3d', 'Heading 1')}
        onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}
        shortcut={h1Shortcut}
      >
        <Heading1 className="size-3.5" />
      </RichMarkdownToolbarButton>
      <RichMarkdownToolbarButton
        active={false}
        label={translate('auto.components.editor.RichMarkdownToolbar.d34a2021c8', 'Heading 2')}
        onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
        shortcut={h2Shortcut}
      >
        <Heading2 className="size-3.5" />
      </RichMarkdownToolbarButton>
      <RichMarkdownToolbarButton
        active={false}
        label={translate('auto.components.editor.RichMarkdownToolbar.cf5817d827', 'Heading 3')}
        onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}
        shortcut={h3Shortcut}
      >
        <Heading3 className="size-3.5" />
      </RichMarkdownToolbarButton>
      <Separator />
      <RichMarkdownToolbarButton
        active={false}
        label={translate('auto.components.editor.RichMarkdownToolbar.4f9e789fe0', 'Bold')}
        onClick={() => editor?.chain().focus().toggleBold().run()}
        shortcut={boldShortcut}
      >
        B
      </RichMarkdownToolbarButton>
      <RichMarkdownToolbarButton
        active={false}
        label={translate('auto.components.editor.RichMarkdownToolbar.6b4ccf9493', 'Italic')}
        onClick={() => editor?.chain().focus().toggleItalic().run()}
        shortcut={italicShortcut}
      >
        I
      </RichMarkdownToolbarButton>
      <RichMarkdownToolbarButton
        active={false}
        label={translate('auto.components.editor.RichMarkdownToolbar.0bea19a988', 'Strike')}
        onClick={() => editor?.chain().focus().toggleStrike().run()}
        shortcut={strikeShortcut}
      >
        S
      </RichMarkdownToolbarButton>
      <Separator />
      <RichMarkdownToolbarButton
        active={false}
        label={translate('auto.components.editor.RichMarkdownToolbar.5d1539e5a9', 'Bullet list')}
        onClick={() => editor?.chain().focus().toggleBulletList().run()}
        shortcut={bulletListShortcut}
      >
        <List className="size-3.5" />
      </RichMarkdownToolbarButton>
      <RichMarkdownToolbarButton
        active={false}
        label={translate('auto.components.editor.RichMarkdownToolbar.31630ed66e', 'Numbered list')}
        onClick={() => editor?.chain().focus().toggleOrderedList().run()}
        shortcut={orderedListShortcut}
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
        shortcut={blockquoteShortcut}
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
      <RichMarkdownMoreBlocksMenu editor={editor} />
    </div>
  )
}
