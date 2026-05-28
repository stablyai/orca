import React from 'react'
import type { Editor } from '@tiptap/react'
import EmojiPicker, { EmojiStyle, Theme, type EmojiClickData } from 'emoji-picker-react'

type RichMarkdownEmojiMenuProps = {
  editor: Editor | null
  left: number
  top: number
  onClose: () => void
}

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
    <div className="rich-markdown-emoji-menu" style={{ left, top }} role="dialog">
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
