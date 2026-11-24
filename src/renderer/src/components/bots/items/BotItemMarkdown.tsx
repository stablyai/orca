// An item's description or comment as Markdown, with links and file paths opening as they do in chat.
import { Children } from 'react'
import { cn } from '@/lib/class-names'
import type { Components } from 'react-markdown'
import CommentMarkdown, {
  type CommentMarkdownExtension
} from '@/components/comment-markdown/CommentMarkdown'
import {
  handleMarkdownAnchorAuxClick,
  handleMarkdownAnchorClick
} from '@/components/comment-markdown/comment-markdown-element-renderers'
import { useNativeChatLinkClick } from '../../native-chat/links/actions/native-chat-link-click-context'
import { useNativeChatFileLinkExists } from '../../native-chat/links/actions/use-native-chat-file-link-existence'
import { botItemFileLinkName } from './bot-item-file-link-name'

export function BotItemMarkdown({
  text,
  shortFileLinks = false
}: {
  text: string
  /** A written-out file path shows as its file name, the path on hover (the item's description). */
  shortFileLinks?: boolean
}): React.JSX.Element {
  const onLinkClick = useNativeChatLinkClick()
  const fileLinkExists = useNativeChatFileLinkExists(onLinkClick !== undefined, false)
  return (
    <CommentMarkdown
      content={text}
      onLinkClick={onLinkClick}
      allowFileUriLinks={onLinkClick !== undefined}
      fileLinkExists={fileLinkExists}
      extension={shortFileLinks ? SHORT_FILE_LINKS : undefined}
      // Paragraphs render as spans: blocks with a gap, as in chat, or blank lines run them together.
      className="text-[13px] leading-[19px] text-foreground [&_.comment-md-p]:block [&_.comment-md-p+.comment-md-p]:mt-2"
    />
  )
}

/** The compact Markdown link, but a link whose text is a file path shows the file name. */
const ShortFileLink: Components['a'] = function ShortFileLink({ href, children }) {
  const onLinkClick = useNativeChatLinkClick()
  const parts = Children.toArray(children)
  const text = parts.length === 1 && typeof parts[0] === 'string' ? parts[0] : null
  const name = text === null ? null : botItemFileLinkName(href, text)
  return (
    <a
      href={href || undefined}
      target="_blank"
      rel="noreferrer"
      title={name ? text! : undefined}
      className={cn(
        'rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        name
          ? 'text-foreground underline decoration-muted-foreground/40 underline-offset-[3px] hover:decoration-foreground'
          : 'underline underline-offset-2 text-foreground/80 hover:text-foreground'
      )}
      onClick={(event) => handleMarkdownAnchorClick(event, href, onLinkClick)}
      onAuxClick={(event) => handleMarkdownAnchorAuxClick(event, href, onLinkClick)}
    >
      {name ?? children}
    </a>
  )
}

// Stable: a new extension object would remount the rendered blocks.
const SHORT_FILE_LINKS: CommentMarkdownExtension = {
  remarkPlugins: [],
  sanitizeAttributes: {},
  components: { a: ShortFileLink }
}
