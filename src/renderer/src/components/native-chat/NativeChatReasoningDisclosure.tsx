import { ChevronRight } from 'lucide-react'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import { NativeChatCodeBlock } from './NativeChatCodeBlock'
import { NativeChatMarkdown } from './NativeChatMarkdown'

/** A reasoning block's text, under the live activity line or its finished row: quieter prose in the
 *  transcript's own type. Capped and scrollable, so an expanded block streaming at the tail cannot
 *  grow without bound. */
export function NativeChatReasoningBody({
  markdown,
  onLinkClick,
  allowFileUriLinks
}: {
  markdown: string
  onLinkClick?: CommentMarkdownLinkClickHandler
  allowFileUriLinks?: boolean
}): React.JSX.Element {
  return (
    <div
      data-native-chat-message-tone="faint"
      className="scrollbar-sleek mt-1 max-h-80 overflow-y-auto pl-5.5 text-chat-foreground-faint"
    >
      <NativeChatMarkdown
        content={markdown}
        variant="document"
        className="text-sm native-chat-message-text"
        renderCodeBlock={NativeChatCodeBlock}
        onLinkClick={onLinkClick}
        allowFileUriLinks={allowFileUriLinks}
        linkifyFilePaths={onLinkClick !== undefined}
      />
    </div>
  )
}

/** The disclosure caret of a `group/reasoning` header: shown on hover, keyboard focus (on the
 *  header or a trigger inside it) and touch, and turned while open. */
export function NativeChatReasoningChevron(): React.JSX.Element {
  return (
    <ChevronRight
      aria-hidden
      className="size-3.5 shrink-0 text-chat-foreground-faint transition-all can-hover:opacity-0 group-hover/reasoning:opacity-100 group-focus-visible/reasoning:opacity-100 group-has-[:focus-visible]/reasoning:opacity-100 group-data-[state=open]/reasoning:rotate-90 group-data-[state=open]/reasoning:opacity-100 motion-reduce:transition-none"
    />
  )
}
