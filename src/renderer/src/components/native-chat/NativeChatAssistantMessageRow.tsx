import { cn } from '@/lib/utils'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import type { deriveNativeChatRowContent } from '../../../../shared/native-chat/transcript/native-chat-row-content'
import type { MessageRowProps } from './NativeChatMessageRow'
import { NativeChatPacedMarkdown } from './NativeChatPacedMarkdown'
import { NATIVE_CHAT_QUOTE_SOURCE_PROPS } from './native-chat-quote-selection'
import { NativeChatToolRun } from './NativeChatToolRun'
import { NativeChatCodeBlock, NativeChatPlainCodeBlock } from './NativeChatCodeBlock'
import { NativeChatAgentControls, NativeChatImageAttachments } from './NativeChatTranscriptChrome'
import { NativeChatForkAction } from './NativeChatForkAction'
import type { useNativeChatWorkRun } from './use-native-chat-work-run'

function messageIsStreaming(
  message: NativeChatMessage,
  working: boolean | undefined,
  trailing: boolean | undefined
): boolean {
  return (
    message.role === 'assistant' &&
    working === true &&
    trailing === true &&
    message.blocks.at(-1)?.type === 'text'
  )
}

export function NativeChatAssistantMessageRow({
  props,
  content,
  run,
  rowRef,
  scrollToTop
}: {
  props: MessageRowProps
  content: ReturnType<typeof deriveNativeChatRowContent>
  run: ReturnType<typeof useNativeChatWorkRun>
  rowRef: React.RefObject<HTMLDivElement | null>
  scrollToTop: () => void
}): React.JSX.Element {
  const {
    message,
    activeTurnIsWorking,
    trailingRun,
    continuesTurn = false,
    onLinkClick,
    allowFileUriLinks = false,
    inSubagentSection = false,
    runtimeContext,
    fork
  } = props
  const { markdown, prose } = content
  const toolRun = toolRunProps(props, content, run)
  const isSystem = message.role === 'system'
  // A thought heading a run reads inside it, so the row has no words of its own.
  const words = message.role === 'reasoning' ? '' : markdown
  // Hide controls on system asides and the still-working frontier, where more content may arrive.
  const showControls =
    !isSystem && words.length > 0 && !continuesTurn && activeTurnIsWorking !== true
  const forkAction =
    fork && words.length > 0 ? <NativeChatForkAction itemId={message.id} fork={fork} /> : null
  const hoverReveal =
    'select-none transition-opacity can-hover:pointer-events-none can-hover:opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 [.group:has(:focus-visible)_&]:pointer-events-auto [.group:has(:focus-visible)_&]:opacity-100'
  const revealOnHover = cn('mt-1 w-fit', hoverReveal)
  // Mid-turn the next row follows too closely to hang controls into, so the fork stays in this response's box.
  const gutterFork = !showControls ? forkAction : null

  return (
    <div
      ref={rowRef}
      // The context menu offers Copy message only where the hover controls offer it.
      data-native-chat-message-id={showControls ? message.id : undefined}
      data-native-chat-message-tone={isSystem ? 'faint' : undefined}
      className={cn(
        'group relative max-w-full select-text text-sm leading-relaxed text-chat-foreground',
        isSystem && 'text-xs text-chat-foreground-faint'
      )}
    >
      <NativeChatImageAttachments
        blocks={prose}
        runtimeContext={runtimeContext}
        enablePreview={runtimeContext !== undefined}
      />
      {words ? (
        <NativeChatForkGutter fork={gutterFork} reveal={hoverReveal}>
          <NativeChatPacedMarkdown
            rowKey={message.id}
            content={words}
            variant="document"
            className="text-sm"
            renderCodeBlock={isSystem ? NativeChatPlainCodeBlock : NativeChatCodeBlock}
            onLinkClick={onLinkClick}
            allowFileUriLinks={allowFileUriLinks}
            linkifyFilePaths={onLinkClick !== undefined}
            {...(isSystem ? {} : NATIVE_CHAT_QUOTE_SOURCE_PROPS)}
            visualMessageId={message.role === 'assistant' ? message.id : undefined}
            // Only the live turn’s prose frontier can be mid-sentence; structured rows have no per-row streaming flag.
            streaming={messageIsStreaming(message, activeTurnIsWorking, trailingRun)}
          />
        </NativeChatForkGutter>
      ) : null}
      {toolRun ? <NativeChatToolRun {...toolRun} /> : null}
      {showControls ? (
        <NativeChatAgentControls
          markdown={words}
          timestamp={message.timestamp}
          onScrollToTop={scrollToTop}
          action={forkAction}
          className={cn(
            revealOnHover,
            // They hang into the gap below; a section keeps them inside its border instead.
            !inSubagentSection && '-mb-5'
          )}
        />
      ) : null}
    </div>
  )
}

/** The response's prose beside a right gutter that holds its fork at the last line; the gutter is
 *  as tall as the prose, so the action never reaches the next row or adds a line. */
function NativeChatForkGutter({
  fork,
  reveal,
  children
}: {
  fork: React.ReactNode
  reveal: string
  children: React.ReactNode
}): React.JSX.Element {
  if (!fork) {
    return <>{children}</>
  }
  return (
    <div className="flex gap-1">
      <div className="min-w-0 flex-1">{children}</div>
      <div data-native-chat-find-skip className="relative w-6 shrink-0">
        <div className={cn('absolute bottom-0 right-0 flex items-center', reveal)}>{fork}</div>
      </div>
    </div>
  )
}

function toolRunProps(
  props: MessageRowProps,
  content: ReturnType<typeof deriveNativeChatRowContent>,
  run: ReturnType<typeof useNativeChatWorkRun>
): React.ComponentProps<typeof NativeChatToolRun> | null {
  if (
    !run &&
    content.tools.length === 0 &&
    content.subagentGroups.length === 0 &&
    content.backgroundTasks.length === 0
  ) {
    return null
  }
  return {
    blocks: run?.blocks ?? content.tools,
    previousTodoWrite: props.previousTodoWrite,
    previousUpdatePlan: props.previousUpdatePlan,
    revealedDiff: run ? run.revealedDiff : props.revealedDiff,
    onRevealDiff: props.onScrollMessageToTop,
    onLinkClick: props.onLinkClick,
    subagentGroups: content.subagentGroups,
    subagentRoster: props.subagentRoster,
    subagentDisclosure: props.subagentDisclosure,
    backgroundTasks: content.backgroundTasks,
    followsProse: content.markdown.length > 0 || content.hasImages,
    expandSignal: props.expandSignal,
    activeTurnIsWorking: props.activeTurnIsWorking,
    trailing: props.trailingRun,
    disclosureId: props.message.id,
    asides: run?.asides,
    runtimeContext: props.runtimeContext
  }
}
