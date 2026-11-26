// An item's description or comment as Markdown, with links and file paths opening as they do in chat.
import CommentMarkdown from '@/components/comment-markdown/CommentMarkdown'
import { useNativeChatLinkClick } from '../../native-chat/links/actions/native-chat-link-click-context'
import { useNativeChatFileLinkExists } from '../../native-chat/links/actions/use-native-chat-file-link-existence'

export function BotItemMarkdown({ text }: { text: string }): React.JSX.Element {
  const onLinkClick = useNativeChatLinkClick()
  const fileLinkExists = useNativeChatFileLinkExists(onLinkClick !== undefined, false)
  return (
    <CommentMarkdown
      content={text}
      onLinkClick={onLinkClick}
      allowFileUriLinks={onLinkClick !== undefined}
      fileLinkExists={fileLinkExists}
      // Paragraphs render as spans: blocks with a gap, as in chat, or blank lines run them together.
      className="text-[13px] leading-[19px] text-foreground [&_.comment-md-p]:block [&_.comment-md-p+.comment-md-p]:mt-2"
    />
  )
}
