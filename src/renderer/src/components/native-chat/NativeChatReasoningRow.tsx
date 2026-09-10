import { useEffect, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import CommentMarkdown, {
  type CommentMarkdownLinkClickHandler
} from '@/components/sidebar/CommentMarkdown'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { translate } from '@/i18n/i18n'
import { formatNativeChatDuration } from '../../../../shared/native-chat-turn-status'

export function NativeChatReasoningRow({
  markdown,
  isStreaming = false,
  blockId = 'default',
  onLinkClick,
  allowFileUriLinks
}: {
  markdown: string
  isStreaming?: boolean
  blockId?: string
  onLinkClick?: CommentMarkdownLinkClickHandler
  allowFileUriLinks?: boolean
}): React.JSX.Element | null {
  const [timing, setTiming] = useState(() => ({
    blockId,
    streaming: isStreaming,
    markdown,
    lastUpdatedAt: Date.now(),
    startedAt: isStreaming ? Date.now() : null,
    elapsedMs: null as number | null
  }))
  useEffect(() => {
    const now = Date.now()
    setTiming((previous) => {
      if (previous.blockId !== blockId) {
        return {
          blockId,
          streaming: isStreaming,
          markdown,
          lastUpdatedAt: now,
          startedAt: isStreaming ? now : null,
          elapsedMs: null
        }
      }
      if (previous.streaming === isStreaming && (!isStreaming || previous.markdown === markdown)) {
        return previous
      }
      // Only an observed stream supplies a duration; journal history has no local start.
      const lastUpdatedAt =
        (isStreaming && !previous.streaming) || previous.markdown !== markdown
          ? now
          : previous.lastUpdatedAt
      return {
        ...previous,
        markdown,
        lastUpdatedAt,
        streaming: isStreaming,
        startedAt: isStreaming && !previous.streaming ? now : previous.startedAt,
        elapsedMs:
          isStreaming || previous.startedAt === null ? null : lastUpdatedAt - previous.startedAt
      }
    })
  }, [blockId, isStreaming, markdown])
  if (!markdown.trim()) {
    return null
  }
  const label = translate('components.native-chat.reasoning', 'Reasoning')
  const duration = timing.blockId === blockId ? timing.elapsedMs : null
  const headline = isStreaming
    ? translate('components.native-chat.thinking', 'Thinking...')
    : duration === null
      ? translate('components.native-chat.thoughtForFewSeconds', 'Thought for a few seconds')
      : translate('components.native-chat.thoughtForDuration', 'Thought for {{duration}}', {
          duration: formatNativeChatDuration(Math.max(1, duration / 1000))
        })

  return (
    <Collapsible className="min-w-0 text-sm text-muted-foreground">
      <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-1.5 rounded-sm py-1 text-left text-[13px] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="sr-only">{label}: </span>
        <span
          className={
            isStreaming
              ? 'min-w-0 truncate animate-pulse motion-reduce:animate-none'
              : 'min-w-0 truncate'
          }
        >
          {headline}
        </span>
        <ChevronRight className="ml-auto size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none" />
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-1 pl-4 italic">
        <CommentMarkdown
          content={markdown}
          variant="document"
          className="text-sm"
          onLinkClick={onLinkClick}
          allowFileUriLinks={allowFileUriLinks}
          linkifyFilePaths={onLinkClick !== undefined}
        />
      </CollapsibleContent>
    </Collapsible>
  )
}
