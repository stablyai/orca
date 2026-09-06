import { memo, useCallback, useMemo, useRef } from 'react'
import CommentMarkdown, {
  type CommentMarkdownLinkClickHandler
} from '@/components/sidebar/CommentMarkdown'
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

/** One message: its prose first, then a collapsible run folding all of the
 *  turn's tool activity. Monochrome per STYLEGUIDE: user prompts read as a
 *  lifted card, assistant prose as body copy, reasoning de-emphasized.
 *  Memoized: a stream frame republishes the whole transcript, but settled rows
 *  keep their block identity, so only the changed row re-renders. */
export const MessageRow = memo(function MessageRow({
  message,
  expandSignal,
  activeTurnIsWorking,
  onScrollMessageToTop,
  onLinkClick,
  allowFileUriLinks = false,
  deliveryFailed = false,
  activityExpandOverride,
  structuredActivityUi = true,
  runtimeContext
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
  const providerFrame = message.blocks.find((block) => block.type === 'text' && block.providerFrame)

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
          {markdown ? (
            <>
              <NativeChatImageAttachments
                blocks={prose}
                runtimeContext={runtimeContext}
                enablePreview={runtimeContext !== undefined}
              />
              <CommentMarkdown
                content={markdown}
                variant="document"
                className="text-sm"
                onLinkClick={onLinkClick}
                allowFileUriLinks={allowFileUriLinks}
              />
            </>
          ) : (
            <NativeChatImageAttachments
              blocks={prose}
              runtimeContext={runtimeContext}
              enablePreview={runtimeContext !== undefined}
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

  // Plain assistant prose is the copyable unit; reasoning/system asides stay
  // chrome-free. The controls reveal on hover (and on keyboard focus-within).
  const showControls = !isReasoning && !isSystem && markdown.length > 0

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
        enablePreview={runtimeContext !== undefined}
      />
      {markdown ? (
        <CommentMarkdown
          content={markdown}
          variant="document"
          className="text-sm"
          onLinkClick={onLinkClick}
          allowFileUriLinks={allowFileUriLinks}
          linkifyFilePaths={onLinkClick !== undefined}
        />
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
          markdown={markdown}
          onScrollToTop={scrollToTop}
          className="pointer-events-none mt-1 -mb-5 w-fit select-none opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
        />
      ) : null}
    </div>
  )
})
