// A comment's files as file links, styled as chat's: their names in one wrapping line. A click goes
// through the item view's link handler, so it gets the regular file-link popover and ⌘ / ⇧⌘ clicks.
import { useContext } from 'react'
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
    <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[13px]">
      {paths.map((path) => {
        const name = chatTextAttachmentName(
          path,
          t('components.native-chat.composer.pastedTextLabel', 'Pasted text')
        )
        const fallback = openText && isCommittedChatAttachmentCandidate(path) ? openText : null
        const href = createNativeChatFileHref(path, 'literal')
        return (
          <a
            key={path}
            href={href}
            title={name}
            className="min-w-0 max-w-full truncate text-primary underline underline-offset-2 hover:text-primary/80"
            onClick={(event) => {
              event.preventDefault()
              if (onLinkClick) {
                onLinkClick(event, href)
              } else {
                fallback?.(path)
              }
            }}
          >
            {name}
          </a>
        )
      })}
    </div>
  )
}
