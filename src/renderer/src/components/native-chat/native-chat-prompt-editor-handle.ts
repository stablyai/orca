import type { Editor } from '@tiptap/react'
import { useImperativeHandle } from 'react'
import type {
  NativeChatComposerInput,
  NativeChatPromptEditorProps
} from './composer/editor/native-chat-composer-input'

export function useNativeChatPromptEditorHandle(
  ref: NativeChatPromptEditorProps['inputRef'],
  editor: Editor | null,
  input: NativeChatComposerInput | null
): void {
  // Tiptap destroys the editor while effects disconnect; a returning effect must not expose it.
  useImperativeHandle<NativeChatComposerInput | null, NativeChatComposerInput | null>(
    ref,
    () => (editor?.isDestroyed === false ? input : null),
    [editor, input]
  )
}
