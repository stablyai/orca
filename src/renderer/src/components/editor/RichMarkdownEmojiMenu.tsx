import React from 'react'
import type { Editor } from '@tiptap/react'
import EmojiPicker, { EmojiStyle, Theme, type EmojiClickData } from 'emoji-picker-react'
import { translate } from '@/i18n/i18n'

type RichMarkdownEmojiMenuProps = {
  editor: Editor | null
  left: number
  top: number
  onClose: () => void
}

/** Floating emoji picker that inserts the chosen emoji at the rich editor's cursor. */
export function RichMarkdownEmojiMenu({
  editor,
  left,
  top,
  onClose
}: RichMarkdownEmojiMenuProps): React.JSX.Element {
  const insertEmoji = (emojiData: EmojiClickData): void => {
    editor?.chain().focus().insertContent(emojiData.emoji).run()
    onClose()
  }

  return (
    <div
      className="rich-markdown-emoji-menu"
      style={{ left, top }}
      role="dialog"
      aria-label={translate(
        'auto.components.editor.RichMarkdownEmojiMenu.dialogLabel',
        'Emoji picker'
      )}
    >
      <EmojiPicker
        autoFocusSearch
        emojiStyle={EmojiStyle.NATIVE}
        height={360}
        lazyLoadEmojis
        onEmojiClick={insertEmoji}
        previewConfig={{ showPreview: false }}
        searchPlaceHolder="Search emoji"
        skinTonesDisabled
        theme={Theme.AUTO}
        width={320}
      />
    </div>
  )
}
