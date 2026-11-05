import React, { useMemo } from 'react'
import type { Editor } from '@tiptap/react'
import EmojiPicker, { EmojiStyle, Theme, type EmojiClickData } from 'emoji-picker-react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useDocumentDarkTheme } from '@/hooks/use-document-dark-theme'
import { translate } from '@/i18n/i18n'
import { useDismissWhenEditorHidden } from './use-dismiss-when-editor-hidden'

type RichMarkdownEmojiMenuProps = {
  editor: Editor | null
  anchorElement: HTMLDivElement | null
  left: number
  top: number
  onClose: () => void
}

export function RichMarkdownEmojiMenu({
  editor,
  anchorElement,
  left,
  top,
  onClose
}: RichMarkdownEmojiMenuProps): React.JSX.Element {
  const isDark = useDocumentDarkTheme()
  useDismissWhenEditorHidden(anchorElement, onClose)
  const virtualRef = useMemo(
    () => ({
      current: {
        contextElement: anchorElement ?? undefined,
        getBoundingClientRect: () => {
          const rect = anchorElement?.getBoundingClientRect()
          return new DOMRect((rect?.left ?? 0) + left, (rect?.top ?? 0) + top, 0, 0)
        }
      }
    }),
    [anchorElement, left, top]
  )
  const insertEmoji = (emojiData: EmojiClickData): void => {
    editor?.chain().focus().insertContent(emojiData.emoji).run()
    onClose()
  }

  return (
    <Popover open onOpenChange={(open) => !open && onClose()}>
      <PopoverAnchor virtualRef={virtualRef} />
      <PopoverContent
        align="start"
        sideOffset={0}
        collisionPadding={8}
        style={{ colorScheme: isDark ? 'dark' : 'light' }}
        aria-label={translate(
          'auto.components.editor.RichMarkdownEmojiMenu.chooseEmoji',
          'Choose an emoji'
        )}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={() => editor?.commands.focus()}
      >
        <div className="rich-markdown-emoji-menu">
          <EmojiPicker
            autoFocusSearch
            emojiStyle={EmojiStyle.NATIVE}
            height={360}
            lazyLoadEmojis
            onEmojiClick={insertEmoji}
            previewConfig={{ showPreview: false }}
            searchPlaceHolder={translate(
              'auto.components.settings.RepositoryIconPicker.searchEmojiPlaceholder',
              'Search emoji'
            )}
            skinTonesDisabled
            theme={isDark ? Theme.DARK : Theme.LIGHT}
            width={320}
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}
