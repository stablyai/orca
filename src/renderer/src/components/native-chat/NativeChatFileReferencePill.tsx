import { useNativeChatPastedTextState } from './native-chat-pasted-text-state'
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import { FileX, Hourglass } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { basename } from '@/lib/path'
import { getFileTypeIcon } from '@/lib/file-type-icons'
import { NativeChatPromptPill } from './NativeChatPromptPill'
import { isNativeChatPastedTextPath } from './native-chat-image-paste'
import {
  nativeChatPasteNotSavedNotice,
  nativeChatPastedTextId,
  nativeChatPastedTextLabel
} from './native-chat-pasted-text-reference'

export function NativeChatFileReferencePill({ node, selected }: NodeViewProps): React.JSX.Element {
  const state = useNativeChatPastedTextState(String(node.attrs.token))
  const path = state && state !== 'saving' && state !== 'unsaved' ? state : String(node.attrs.path)
  const pasteId = nativeChatPastedTextId(String(node.attrs.token))
  // A paste's pill with no saving behind it was lost to a restart: its text was only in memory.
  const unsaved = state === 'unsaved'
  return (
    <NodeViewWrapper as="span" className="inline" contentEditable={false}>
      <NativeChatPromptPill
        icon={unsaved ? FileX : state === 'saving' ? Hourglass : getFileTypeIcon(path)}
        label={
          unsaved
            ? translate('components.native-chat.composer.pasteNotSavedLabel', 'Paste not saved')
            : pasteId || isNativeChatPastedTextPath(path)
              ? nativeChatPastedTextLabel()
              : basename(path)
        }
        selected={selected}
        title={unsaved ? nativeChatPasteNotSavedNotice() : path || undefined}
        data-native-chat-file-reference={path}
      />
    </NodeViewWrapper>
  )
}
