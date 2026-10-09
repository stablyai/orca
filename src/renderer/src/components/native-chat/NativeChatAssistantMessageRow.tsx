import { cn } from '@/lib/utils'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { deriveNativeChatRowContent } from '../../../../shared/native-chat-row-content'
import type { MessageRowProps } from './NativeChatMessageRow'
import { NativeChatPacedMarkdown } from './NativeChatPacedMarkdown'
import { NATIVE_CHAT_QUOTE_SOURCE_PROPS } from './native-chat-quote-selection'
import { NativeChatToolRun } from './NativeChatToolRun'
import { NativeChatCodeBlock, NativeChatPlainCodeBlock } from './NativeChatCodeBlock'
import { NativeChatAgentControls, NativeChatImageAttachments } from './NativeChatTranscriptChrome'
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
    runtimeContext
  } = props
  const { markdown, prose } = content
  const toolRun = toolRunProps(props, content, run)
  const isSystem = message.role === 'system'
  // A thought heading a run reads inside it, so the row has no words of its own.
  const words = message.role === 'reasoning' ? '' : markdown
  // Assistant controls reveal on hover and keyboard focus; system asides stay chrome-free.
  const showControls = !isSystem && words.length > 0 && !continuesTurn

  return (
    <div
      ref={rowRef}
      data-native-chat-message-tone={isSystem ? 'faint' : undefined}
      className={cn(
        'group relative max-w-full select-text text-sm leading-relaxed text-chat-foreground',
        !isSystem && 'native-chat-message-text',
        isSystem && 'text-xs text-chat-foreground-faint'
      )}
    >
      <NativeChatImageAttachments
        blocks={prose}
        runtimeContext={runtimeContext}
        enablePreview={runtimeContext !== undefined}
      />
      {words ? (
        <NativeChatPacedMarkdown
          rowKey={message.id}
          content={words}
          variant="document"
          className="text-sm native-chat-message-text"
          renderCodeBlock={isSystem ? NativeChatPlainCodeBlock : NativeChatCodeBlock}
          onLinkClick={onLinkClick}
          allowFileUriLinks={allowFileUriLinks}
          linkifyFilePaths={onLinkClick !== undefined}
          {...(isSystem ? {} : NATIVE_CHAT_QUOTE_SOURCE_PROPS)}
          visualMessageId={message.role === 'assistant' ? message.id : undefined}
          // Structured text streams in place with no per-row state: only the live turn's frontier
          // row, still ending in prose, can be mid-sentence.
          streaming={messageIsStreaming(message, activeTurnIsWorking, trailingRun)}
        />
      ) : null}
      {toolRun ? <NativeChatToolRun {...toolRun} /> : null}
      {showControls ? (
        <NativeChatAgentControls
          markdown={words}
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
    asides: run?.asides
  }
}
