import { useEffect, useState, type ComponentProps } from 'react'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { cn } from '@/lib/utils'
import { withoutPendingNativeChatVisualDirectiveTail } from '../../../../shared/native-chat-visual-directive'
import { useNativeChatVisualMarkdownExtension } from './native-chat-visual-markdown-extension'
import './native-chat-markdown.css'

/** Existing words stay opaque when a reply first starts growing. */
function useWordFadeArmed(fadeWords: boolean): boolean {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!fadeWords) {
      setArmed(false)
      return
    }
    const frame = requestAnimationFrame(() => setArmed(true))
    return () => cancelAnimationFrame(frame)
  }, [fadeWords])
  return armed && fadeWords
}

type NativeChatMarkdownProps = ComponentProps<typeof CommentMarkdown> & {
  visualMessageId?: string
  streaming?: boolean
}

export function NativeChatMarkdown({
  className,
  fadeWords = false,
  visualMessageId,
  streaming = false,
  content,
  ...props
}: NativeChatMarkdownProps): React.JSX.Element {
  const wordFadeArmed = useWordFadeArmed(fadeWords)
  const extension = useNativeChatVisualMarkdownExtension(visualMessageId)
  return (
    <CommentMarkdown
      {...props}
      content={
        extension && streaming ? withoutPendingNativeChatVisualDirectiveTail(content) : content
      }
      extension={extension}
      fadeWords={fadeWords}
      renderMermaid={!streaming}
      keepMermaidSourceWhilePending
      data-word-fade={wordFadeArmed ? '' : undefined}
      data-block-fade={wordFadeArmed && streaming ? '' : undefined}
      className={cn('native-chat-markdown', className)}
    />
  )
}
