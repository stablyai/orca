import { useEffect, useState, type ComponentProps } from 'react'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { cn } from '@/lib/utils'
import { withoutPendingNativeChatVisualDirectiveTail } from '../../../../shared/native-chat-visual-directive'
import { useNativeChatVisualMarkdownExtension } from './native-chat-visual-markdown-extension'
import { useNativeChatFileLinkExists } from './use-native-chat-file-link-existence'
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

type NativeChatMarkdownProps = Omit<ComponentProps<typeof CommentMarkdown>, 'fileLinkExists'> & {
  /** Underline file paths in the text that exist in the chat's workspace. */
  linkifyFilePaths?: boolean
  visualMessageId?: string
  streaming?: boolean
}

export function NativeChatMarkdown({
  className,
  linkifyFilePaths = false,
  fadeWords = false,
  visualMessageId,
  streaming = false,
  content,
  ...props
}: NativeChatMarkdownProps): React.JSX.Element {
  const wordFadeArmed = useWordFadeArmed(fadeWords)
  const extension = useNativeChatVisualMarkdownExtension(visualMessageId)
  const fileLinkExists = useNativeChatFileLinkExists(linkifyFilePaths, streaming)
  return (
    <CommentMarkdown
      {...props}
      content={
        extension && streaming ? withoutPendingNativeChatVisualDirectiveTail(content) : content
      }
      extension={extension}
      fileLinkExists={fileLinkExists}
      fadeWords={fadeWords}
      renderMermaid={!streaming}
      keepMermaidSourceWhilePending
      data-word-fade={wordFadeArmed ? '' : undefined}
      data-block-fade={wordFadeArmed && streaming ? '' : undefined}
      className={cn('native-chat-markdown', className)}
    />
  )
}
