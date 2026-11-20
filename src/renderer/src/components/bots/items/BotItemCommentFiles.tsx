// A comment's files as chat's file buttons. Each is a file link: a click goes through the item view's
// link handler, so it gets the link popover, its rows and its ⌘ / ⇧⌘ clicks like any file link there.
import { useContext } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { createNativeChatFileHref } from '../../../../../shared/native-chat/file-access/native-chat-href-routing'
import {
  chatTextAttachmentName,
  isCommittedChatAttachmentCandidate
} from '../../../../../shared/native-chat/attachments/native-chat-text-attachment-references'
import { useNativeChatLinkClick } from '../../native-chat/links/actions/native-chat-link-click-context'
import { NativeChatTextAttachmentOpener } from '../../native-chat/media/text/NativeChatTextAttachments'

export function BotItemCommentFiles({
  paths
}: {
  paths: readonly string[]
}): React.JSX.Element | null {
  const t = useTranslate()
  const onLinkClick = useNativeChatLinkClick()
  // Where links don't open, a text file still opens chat's preview.
  const openText = useContext(NativeChatTextAttachmentOpener)
  if (paths.length === 0) {
    return null
  }
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {paths.map((path) => {
        const name = chatTextAttachmentName(
          path,
          t('components.native-chat.composer.pastedTextLabel', 'Pasted text')
        )
        const fallback = openText && isCommittedChatAttachmentCandidate(path) ? openText : null
        return (
          <Button
            key={path}
            type="button"
            variant="outline"
            size="sm"
            className="max-w-full"
            title={name}
            disabled={!onLinkClick && !fallback}
            onClick={(event) =>
              onLinkClick
                ? onLinkClick(event, createNativeChatFileHref(path, 'literal'))
                : fallback?.(path)
            }
          >
            <span className="truncate">{name}</span>
          </Button>
        )
      })}
    </div>
  )
}
