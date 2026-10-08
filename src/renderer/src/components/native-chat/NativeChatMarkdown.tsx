import type { ComponentProps } from 'react'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { cn } from '@/lib/utils'
import { withoutPendingNativeChatVisualDirectiveTail } from '../../../../shared/native-chat-visual-directive'
import { useNativeChatVisualMarkdownExtension } from './native-chat-visual-markdown-extension'
import './native-chat-markdown.css'

type NativeChatMarkdownProps = ComponentProps<typeof CommentMarkdown> & {
  /** On assistant prose in a structured chat: this message may show visuals. */
  visualMessageId?: string
  /** The reply is still arriving, so an unfinished visual line at its end is held back. */
  streaming?: boolean
}

export function NativeChatMarkdown({
  className,
  visualMessageId,
  streaming = false,
  content,
  ...props
}: NativeChatMarkdownProps): React.JSX.Element {
  const extension = useNativeChatVisualMarkdownExtension(visualMessageId)
  return (
    <CommentMarkdown
      {...props}
      content={
        extension && streaming ? withoutPendingNativeChatVisualDirectiveTail(content) : content
      }
      extension={extension}
      renderMermaid={!streaming}
      className={cn('native-chat-markdown', className)}
    />
  )
}
