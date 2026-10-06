import type { ComponentProps } from 'react'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { cn } from '@/lib/utils'
import './native-chat-markdown.css'

export function NativeChatMarkdown({
  className,
  ...props
}: ComponentProps<typeof CommentMarkdown>): React.JSX.Element {
  return <CommentMarkdown {...props} className={cn('native-chat-markdown', className)} />
}
