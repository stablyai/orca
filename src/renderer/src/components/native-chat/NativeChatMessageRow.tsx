import { memo, useCallback, useRef } from 'react'
import { Goal, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import CommentMarkdown, {
  type CommentMarkdownLinkClickHandler
} from '@/components/sidebar/CommentMarkdown'
import type { StreamingMarkdownFade } from '@/components/sidebar/streaming-markdown-fade'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type {
  NativeChatMessage,
  NativeChatToolCallBlock
} from '../../../../shared/native-chat-types'
import { deriveNativeChatRowContent } from '../../../../shared/native-chat-row-content'
import { NativeChatToolRun } from './NativeChatToolRun'
import { NativeChatCodeBlock } from './NativeChatCodeBlock'
import { NativeChatNoticeRow } from './NativeChatNoticeRow'
import { NativeChatCopyButton } from './NativeChatCopyButton'
import { NativeChatMessageTimestamp } from './NativeChatMessageTimestamp'
import {
  NativeChatAgentControls,
  NativeChatImageAttachments,
  ProviderFrameRow
} from './NativeChatTranscriptChrome'
import type { NativeChatDiffReveal } from './native-chat-turn-diffs'
import type {
  NativeChatSubagentDisclosure,
  NativeChatSubagentRosterState
} from './native-chat-subagent-sections'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import { literalRoomTransportText } from './native-chat-room-transport'
import type { NativeChatImageLoadContext } from './NativeChatImageAttachments'

/** What a user message says under it when it did not go through, with its own Retry when the
 *  surface can send it again. */
export type NativeChatDeliveryNotice = {
  text: string
  onRetry?: () => void
  onDismiss?: () => void
}

/** One message: its prose first, then a collapsible run folding all of the
 *  turn's tool activity. Monochrome per STYLEGUIDE: user prompts read as a
 *  lifted card, assistant prose as body copy, reasoning de-emphasized.
 *  Memoized: a stream frame republishes the whole transcript, but settled rows
 *  keep their block identity, so only the changed row re-renders. */
export const MessageRow = memo(function MessageRow({
  message,
  previousTodoWrite,
  previousUpdatePlan,
  revealedDiff,
  expandSignal,
  activeTurnIsWorking,
  trailingRun,
  onScrollMessageToTop,
  onLinkClick,
  allowFileUriLinks = false,
  deliveryNotice,
  folded = false,
  subagentRoster,
  subagentDisclosure,
  inSubagentSection = false,
  runtimeContext,
  imageLoadContext,
  streamingFade
}: {
  message: NativeChatMessage
  previousTodoWrite?: NativeChatToolCallBlock
  previousUpdatePlan?: NativeChatToolCallBlock
  revealedDiff?: NativeChatDiffReveal
  expandSignal: boolean
  activeTurnIsWorking?: boolean
  /** This row's tool run is the turn's last, so it is the one still live. */
  trailingRun?: boolean
  /** Align this message's top to the top of the scroll viewport. */
  onScrollMessageToTop: (el: HTMLElement) => void
  onLinkClick?: CommentMarkdownLinkClickHandler
  allowFileUriLinks?: boolean
  deliveryNotice?: NativeChatDeliveryNotice
  /** Behind a folded turn: the row keeps only what outlives the turn. */
  folded?: boolean
  /** On a roster row: its list's state and the subagents whose rows open below it. */
  subagentRoster?: NativeChatSubagentRosterState
  subagentDisclosure?: NativeChatSubagentDisclosure
  /** Inside a subagent's section, whose border has to reach past the row's controls. */
  inSubagentSection?: boolean
  runtimeContext?: RuntimeFileOperationArgs | null
  imageLoadContext?: NativeChatImageLoadContext
  streamingFade?: StreamingMarkdownFade
}): React.JSX.Element | null {
  const rowRef = useRef<HTMLDivElement | null>(null)
  // One pass per block set, shared with the list that decides whether this row
  // occupies a slot — so "draws nothing" means the same thing to both.
  const { backgroundTasks, hasImages, markdown, prose, subagentGroups, tools } =
    deriveNativeChatRowContent(message.blocks)
  const isUser = message.role === 'user'
  const isReasoning = message.role === 'reasoning'
  const isSystem = message.role === 'system'
  const providerFrame = message.blocks.find((block) => block.type === 'text' && block.providerFrame)
  const isSubagentTask = message.subagentEvent?.kind === 'task'
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
  if (
    markdown.length === 0 &&
    !hasImages &&
    tools.length === 0 &&
    subagentGroups.length === 0 &&
    backgroundTasks.length === 0
  ) {
    return null
  }

  // Behind a folded turn this row is the work, not the answer. Rows that outlive
  // their turn never reach here — the fold leaves them out.
  if (folded) {
    return null
  }

  const notice = isSystem
    ? message.blocks.find(
        (block) =>
          block.type === 'text' && (block.presentation !== undefined || block.tone !== undefined)
      )
    : undefined
  if (notice?.type === 'text') {
    return (
      <div ref={rowRef}>
        <NativeChatNoticeRow
          block={notice}
          onLinkClick={onLinkClick}
          allowFileUriLinks={allowFileUriLinks}
        />
      </div>
    )
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
      <div ref={rowRef} className="group relative flex flex-col items-end gap-0.5">
        {/* User turns get a distinct muted fill (not the card/canvas color) so
            the prompt reads apart from the assistant's body copy. */}
        <div className="max-w-[85%] rounded-lg rounded-tr-sm bg-muted px-3.5 py-2.5 text-sm text-foreground">
          {renderedText ? (
            <>
              <NativeChatImageAttachments
                blocks={prose}
                runtimeContext={runtimeContext}
                enablePreview={runtimeContext !== undefined}
                loadContext={imageLoadContext}
              />
              {literalTransport !== null ? (
                <div className="whitespace-pre-wrap break-words">{renderedText}</div>
              ) : (
                <CommentMarkdown
                  content={renderedText}
                  variant="document"
                  className="text-sm"
                  renderCodeBlock={NativeChatCodeBlock}
                  onLinkClick={onLinkClick}
                  allowFileUriLinks={allowFileUriLinks}
                />
              )}
            </>
          ) : (
            <NativeChatImageAttachments
              blocks={prose}
              runtimeContext={runtimeContext}
              enablePreview={runtimeContext !== undefined}
              loadContext={imageLoadContext}
            />
          )}
        </div>
        {message.sentAs === 'goal' ? (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Goal className="size-3" aria-hidden />
            <span>{translate('components.native-chat.goal.sentAsGoal', 'Sent as goal')}</span>
          </div>
        ) : null}
        {/* Copy + timestamp reveal together, mirroring the agent controls row.
            Image-only prompts have no text to copy, so the button is omitted. */}
        {markdown || message.timestamp !== null ? (
          <div className="flex select-none items-center gap-1 transition-opacity can-hover:pointer-events-none can-hover:opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 [.group:has(:focus-visible)_&]:pointer-events-auto [.group:has(:focus-visible)_&]:opacity-100">
            {markdown ? <NativeChatCopyButton text={markdown} /> : null}
            <NativeChatMessageTimestamp timestamp={message.timestamp} focusable />
          </div>
        ) : null}
        {deliveryNotice ? (
          <div className="flex max-w-[85%] items-center gap-2 text-[11px] text-destructive/80">
            <span className="min-w-0 break-words">{deliveryNotice.text}</span>
            {deliveryNotice.onDismiss ? (
              <Button type="button" variant="ghost" size="xs" onClick={deliveryNotice.onDismiss}>
                {translate('components.native-chat.dismissDeliveryNotice', 'Dismiss')}
              </Button>
            ) : null}
            {deliveryNotice.onRetry ? (
              <Button type="button" variant="ghost" size="xs" onClick={deliveryNotice.onRetry}>
                <RotateCcw className="size-3" />
                {translate(
                  'auto.components.native.chat.NativeChatStructuredSession.a5e7f14068',
                  'Retry'
                )}
              </Button>
            ) : null}
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

  // Plain assistant prose is the copyable unit; reasoning/system asides stay
  // chrome-free. Controls reveal on hover/keyboard focus and stay visible on touch.
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
        enablePreview={runtimeContext !== undefined}
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
            renderCodeBlock={NativeChatCodeBlock}
            onLinkClick={onLinkClick}
            allowFileUriLinks={allowFileUriLinks}
            streamingFade={streamingFade}
            linkifyFilePaths={onLinkClick !== undefined}
          />
        )
      ) : null}
      {tools.length > 0 || subagentGroups.length > 0 || backgroundTasks.length > 0 ? (
        <NativeChatToolRun
          blocks={tools}
          previousTodoWrite={previousTodoWrite}
          previousUpdatePlan={previousUpdatePlan}
          revealedDiff={revealedDiff}
          onRevealDiff={onScrollMessageToTop}
          onLinkClick={onLinkClick}
          subagentGroups={subagentGroups}
          subagentRoster={subagentRoster}
          subagentDisclosure={subagentDisclosure}
          backgroundTasks={backgroundTasks}
          expandSignal={expandSignal}
          activeTurnIsWorking={activeTurnIsWorking}
          trailing={trailingRun}
          disclosureId={message.id}
        />
      ) : null}
      {showControls ? (
        <NativeChatAgentControls
          markdown={renderedText}
          timestamp={message.timestamp}
          onScrollToTop={scrollToTop}
          className={cn(
            'mt-1 w-fit select-none transition-opacity can-hover:pointer-events-none can-hover:opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 [.group:has(:focus-visible)_&]:pointer-events-auto [.group:has(:focus-visible)_&]:opacity-100',
            // They hang into the gap below; a section keeps them inside its border instead.
            !inSubagentSection && '-mb-5'
          )}
        />
      ) : null}
    </div>
  )
})
