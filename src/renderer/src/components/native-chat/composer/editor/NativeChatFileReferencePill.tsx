import { useContext } from 'react'
import { NativeChatTextAttachmentOpener } from '../../media/text/NativeChatTextAttachments'
import { isCommittedChatAttachmentCandidate } from '../../../../../../shared/native-chat-text-attachment-references'
import {
  useNativeChatPastedTextScope,
  useNativeChatPastedTextState
} from './native-chat-pasted-text-state'
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import { FileX, Hourglass } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { basename } from '@/lib/path'
import { getFileTypeIcon } from '@/lib/file-icons/file-type-icons'
import { NativeChatPromptPill } from './NativeChatPromptPill'
import { isNativeChatPastedTextPath } from '../../../../../../shared/native-chat/native-chat-image-label'
import {
  nativeChatPastedTextOperations,
  nativeChatPasteNotSavedNotice,
  nativeChatPastedTextId,
  nativeChatPastedTextLabel
} from '../../paste/native-chat-pasted-text-reference'

export function NativeChatFileReferencePill({ node, selected }: NodeViewProps): React.JSX.Element {
  const t = useTranslate()
  const state = useNativeChatPastedTextState(String(node.attrs.token))
  const path = state && state !== 'saving' && state !== 'unsaved' ? state : String(node.attrs.path)
  const pasteId = nativeChatPastedTextId(String(node.attrs.token))
  // A paste's pill with no saving behind it was lost to a restart: its text was only in memory.
  const open = useContext(NativeChatTextAttachmentOpener)
  const scope = useNativeChatPastedTextScope()
  const live = pasteId ? nativeChatPastedTextOperations.get(pasteId) : undefined
  const canOpen = open && (live?.scopeKey === scope || isCommittedChatAttachmentCandidate(path))
  const unsaved = state === 'unsaved'
  const pill = (
    <NativeChatPromptPill
      icon={unsaved ? FileX : state === 'saving' ? Hourglass : getFileTypeIcon(path)}
      label={
        unsaved
          ? t('components.native-chat.composer.pasteNotSavedLabel', 'Paste not saved')
          : pasteId || isNativeChatPastedTextPath(path)
            ? nativeChatPastedTextLabel(t)
            : basename(path)
      }
      selected={selected}
      title={unsaved ? nativeChatPasteNotSavedNotice(t) : path || undefined}
      data-native-chat-file-reference={path}
    />
  )
  return (
    <NodeViewWrapper as="span" className="inline" contentEditable={false}>
      {canOpen ? (
        <button
          type="button"
          className="inline max-w-full cursor-pointer text-left"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => open(path, live?.scopeKey === scope ? live.text : undefined)}
        >
          {pill}
        </button>
      ) : (
        pill
      )}
    </NodeViewWrapper>
  )
}
