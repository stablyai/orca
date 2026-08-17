import { memo, useCallback, useMemo, useRef } from 'react'
import CommentMarkdown, {
  type CommentMarkdownLinkClickHandler
} from '@/components/sidebar/CommentMarkdown'
import type { StreamingMarkdownFade } from '@/components/sidebar/streaming-markdown-fade'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { splitNativeChatBlocks } from './native-chat-tool-fold'
import { NativeChatToolRun } from './NativeChatToolRun'
import { nativeChatProseToMarkdown } from './native-chat-prose'
import {
  NativeChatAgentControls,
  NativeChatImageAttachments,
  ProviderFrameRow
} from './NativeChatTranscriptChrome'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import { literalRoomTransportText } from './native-chat-room-transport'
import type { NativeChatImageLoadContext } from './NativeChatImageAttachments'

/** One message: its prose first, then a collapsible run folding all of the
 *  turn's tool activity. Monochrome per STYLEGUIDE: user prompts read as a
 *  lifted card, assistant prose as body copy, reasoning de-emphasized.
 *  Memoized: a stream frame republishes the whole transcript, but settled rows
 *  keep their block identity, so only the changed row re-renders. */
export const NativeChatMessageRow = memo(function NativeChatMessageRow({
  message,
  expandSignal,
  activeTurnIsWorking,
  onScrollMessageToTop,
  onLinkClick,
  allowFileUriLinks = false,
  deliveryFailed = false,
  activityExpandOverride,
  structuredActivityUi = true,
  runtimeContext,
  imageLoadContext,
  streamingFade
}: {
  message: NativeChatMessage
  expandSignal: boolean
  activeTurnIsWorking?: boolean
  /** Align this message's top to the top of the scroll viewport. */
  onScrollMessageToTop: (el: HTMLElement) => void
  onLinkClick?: CommentMarkdownLinkClickHandler
  allowFileUriLinks?: boolean
  deliveryFailed?: boolean
  activityExpandOverride?: boolean
  structuredActivityUi?: boolean
  runtimeContext?: RuntimeFileOperationArgs | null
  imageLoadContext?: NativeChatImageLoadContext
  streamingFade?: StreamingMarkdownFade
}): React.JSX.Element | null {
  const rowRef = useRef<HTMLDivElement | null>(null)
  // One pass per block set: a streaming turn re-renders this row on every frame, and these
  // derivations used to re-run each time even though `message.blocks` had not changed.
  const { hasImages, markdown, prose, tools } = useMemo(() => {
    const split = splitNativeChatBlocks(message.blocks)
    return {
      ...split,
      markdown: nativeChatProseToMarkdown(split.prose),
      hasImages: split.prose.some((block) => block.type === 'image-ref')
    }
  }, [message.blocks])
  const isUser = message.role === 'user'
  const isReasoning = message.role === 'reasoning'
  const isSystem = message.role === 'system'
  const isSubagentTask = message.subagentEvent?.kind === 'task'
  const providerFrame = message.blocks.find((block) => block.type === 'text' && block.providerFrame)
  const literalTransport = literalRoomTransportText(markdown)
  const renderedText = literalTransport ?? markdown

  const scrollToTop = useCallback(() => {
    if (rowRef.current) {
      onScrollMessageToTop(rowRef.current)
    }
  }, [onScrollMessageToTop])

  // Skip rows with nothing renderable so the transcript shows no empty/ghost
  // bubble.
  // After all hooks, so hook order stays unconditional.
  if (markdown.length === 0 && !hasImages && tools.length === 0) {
    return null
  }

  if (providerFrame) {
    return (
      <div ref={rowRef}>
        <ProviderFrameRow block={providerFrame} />
      </div>
    )
  }

  if (isUser) {
    return (
      <div ref={rowRef} className="flex flex-col items-end gap-0.5">
        {/* User turns get a distinct muted fill (not the card/canvas color) so
            the prompt reads apart from the assistant's body copy. */}
        <div className="max-w-[85%] rounded-lg rounded-tr-sm bg-muted px-3.5 py-2.5 text-sm text-foreground">
          {renderedText ? (
            <>
              <NativeChatImageAttachments
                blocks={prose}
                runtimeContext={runtimeContext}
                loadContext={imageLoadContext}
              />
              {literalTransport !== null ? (
                <div className="whitespace-pre-wrap break-words">{renderedText}</div>
              ) : (
                <CommentMarkdown
                  content={renderedText}
                  variant="document"
                  className="text-sm"
                  onLinkClick={onLinkClick}
                  allowFileUriLinks={allowFileUriLinks}
                />
              )}
            </>
          ) : (
            <NativeChatImageAttachments
              blocks={prose}
              runtimeContext={runtimeContext}
              loadContext={imageLoadContext}
            />
          )}
        </div>
        {deliveryFailed ? (
          <div className="max-w-[85%] text-[11px] text-destructive/80">
            {translate(
              'components.native-chat.launchPromptNotDelivered',
              'Not delivered — check the terminal'
            )}
          </div>
        ) : null}
      </div>
    )
  }

  if (isSubagentTask) {
    return (
      <div
        ref={rowRef}
        className="w-fit rounded-md border border-border bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground"
      >
        {markdown}
      </div>
    )
  }

  const showControls = !isReasoning && !isSystem && renderedText.length > 0

  return (
    <div
      ref={rowRef}
      className={cn(
        'group relative max-w-full select-text text-sm leading-relaxed text-foreground',
        // Reasoning is the agent thinking aloud — quieter, italic, like an aside.
        isReasoning && 'border-l-2 border-border/60 pl-3 italic text-muted-foreground',
        isSystem && 'text-xs text-muted-foreground'
      )}
    >
      <NativeChatImageAttachments
        blocks={prose}
        runtimeContext={runtimeContext}
        loadContext={imageLoadContext}
      />
      {renderedText ? (
        literalTransport !== null ? (
          <div className="whitespace-pre-wrap break-words">{renderedText}</div>
        ) : (
        <CommentMarkdown
          content={renderedText}
          variant="document"
          className="text-sm"
          onLinkClick={onLinkClick}
          allowFileUriLinks={allowFileUriLinks}
          streamingFade={streamingFade}
          linkifyFilePaths={onLinkClick !== undefined}
        />
        )
      ) : null}
      {tools.length > 0 ? (
        <NativeChatToolRun
          blocks={tools}
          expandSignal={expandSignal}
          expandOverride={activityExpandOverride}
          activeTurnIsWorking={activeTurnIsWorking}
          structuredActivityUi={structuredActivityUi}
        />
      ) : null}
      {showControls ? (
        <NativeChatAgentControls
          markdown={renderedText}
          onScrollToTop={scrollToTop}
          className="pointer-events-none mt-1 -mb-5 w-fit select-none opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
        />
      ) : null}
    </div>
  )
})
