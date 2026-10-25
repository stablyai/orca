import { ChevronRight } from 'lucide-react'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import { NativeChatCodeBlock } from './NativeChatCodeBlock'
import { NativeChatMarkdown } from './NativeChatMarkdown'

/** Bound reasoning height so expanded streaming output cannot grow the transcript indefinitely. */
export function NativeChatReasoningBody({
  markdown,
  onLinkClick,
  allowFileUriLinks,
  rowKey,
  streaming = false
}: {
  markdown: string
  /** The reasoning block's disclosure key, shared by its live line and finished row. */
  rowKey?: string
  onLinkClick?: CommentMarkdownLinkClickHandler
  allowFileUriLinks?: boolean
  /** The block is still arriving under the live activity line. */
  streaming?: boolean
}): React.JSX.Element {
  return (
    <div
      data-native-chat-message-tone="faint"
      className="scrollbar-sleek mt-1 max-h-80 overflow-y-auto pl-5.5 text-chat-foreground-faint"
    >
      <NativeChatMarkdown
        rowKey={rowKey}
        content={markdown}
        variant="document"
        className="text-sm"
        renderCodeBlock={NativeChatCodeBlock}
        onLinkClick={onLinkClick}
        allowFileUriLinks={allowFileUriLinks}
        linkifyFilePaths={onLinkClick !== undefined}
        streaming={streaming}
      />
    </div>
  )
}

export function NativeChatReasoningChevron(): React.JSX.Element {
  return (
    <ChevronRight
      aria-hidden
      className="size-3.5 shrink-0 text-chat-foreground-faint transition-all can-hover:opacity-0 group-hover/reasoning:opacity-100 group-focus-visible/reasoning:opacity-100 group-has-[:focus-visible]/reasoning:opacity-100 group-data-[state=open]/reasoning:rotate-90 group-data-[state=open]/reasoning:opacity-100 motion-reduce:transition-none"
    />
  )
}
