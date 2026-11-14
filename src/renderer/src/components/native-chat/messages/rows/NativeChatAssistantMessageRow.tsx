import { useContext } from 'react'
import { cn } from '@/lib/class-names'
import { isRootAgentJournalItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-producer'
import { NativeChatForkSlotContext } from '../actions/native-chat-fork-context'
import { nativeChatAgentRowWords } from './native-chat-message-row-words'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { deriveNativeChatRowContent } from '../../../../../../shared/native-chat/transcript/native-chat-row-content'
import type { MessageRowProps } from './NativeChatMessageRow'
import { NativeChatPacedMarkdown } from '../../markdown/NativeChatPacedMarkdown'
import { NATIVE_CHAT_QUOTE_SOURCE_PROPS } from '../../selection-quotes/native-chat-quote-selection'
import { NativeChatToolRun } from '../../tools/runs/NativeChatToolRun'
import {
  NativeChatCodeBlock,
  NativeChatPlainCodeBlock
} from '../../markdown/code/NativeChatCodeBlock'
import { NativeChatAgentControls } from '../actions/NativeChatAgentControls'
import { useNativeChatAutoSpeech } from '../actions/use-native-chat-auto-speech'
import { NativeChatImageAttachments } from '../../media/images/NativeChatImageAttachments'
import { NativeChatForkAction } from '../actions/NativeChatForkAction'
import type { useNativeChatWorkRun } from '../../tools/runs/use-native-chat-work-run'
import { useTranslate } from '@/i18n/use-translate'

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
  const t = useTranslate()
  const {
    message,
    activeTurnIsWorking,
    trailingRun,
    continuesTurn = false,
    endsResponse,
    latestResponse = true,
    actionsHang = false,
    runtimeContext,
    fork
  } = props
  const { prose, hasImages } = content
  const toolRun = toolRunProps(props, content, run)
  const isSystem = message.role === 'system'
  // The same words slot construction chooses the turn's action holder by; Copy needs them.
  const words = nativeChatAgentRowWords(message, t)
  const answer =
    message.role === 'assistant' && words.length > 0 && (endsResponse ?? !continuesTurn)
  // The turn's last reply is the result. Read it when the turn stops, not when a later step replaces it.
  useNativeChatAutoSpeech({
    messageId: message.id,
    markdown: words,
    answer,
    working: activeTurnIsWorking === true
  })
  // Hide controls on system asides and the still-working frontier, where more content may arrive. In
  // a turn they belong to its holder, which may draw only images when folding hid its words.
  const showControls =
    !isSystem &&
    (endsResponse ?? (words.length > 0 && !continuesTurn)) &&
    (words.length > 0 || hasImages) &&
    activeTurnIsWorking !== true
  // Fixed by the row's own kind, never by support or eligibility, so the row's actions never shift.
  const holdsForkSlot =
    useContext(NativeChatForkSlotContext) &&
    message.role === 'assistant' &&
    message.source === 'transcript' &&
    !message.agentStart &&
    isRootAgentJournalItem(message)

  return (
    <div
      ref={rowRef}
      // The context menu offers Copy and Speak only where the row's controls offer them.
      data-native-chat-message-id={showControls && words.length > 0 ? message.id : undefined}
      data-native-chat-speakable={showControls && words.length > 0 ? '' : undefined}
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
        <NativeChatPacedMarkdown
          rowKey={message.id}
          content={words}
          variant="document"
          className="text-sm"
          renderCodeBlock={isSystem ? NativeChatPlainCodeBlock : NativeChatCodeBlock}
          linkifyFilePaths
          {...(isSystem ? {} : NATIVE_CHAT_QUOTE_SOURCE_PROPS)}
          visualMessageId={message.role === 'assistant' ? message.id : undefined}
          // Only the live turn’s prose frontier can be mid-sentence; structured rows have no per-row streaming flag.
          streaming={messageIsStreaming(message, activeTurnIsWorking, trailingRun)}
        />
      ) : null}
      {toolRun ? <NativeChatToolRun {...toolRun} /> : null}
      {showControls ? (
        <NativeChatAgentControls
          messageId={message.id}
          markdown={words}
          timestamp={message.timestamp}
          onScrollToTop={scrollToTop}
          action={
            fork ? (
              <NativeChatForkAction itemId={message.id} fork={fork} />
            ) : holdsForkSlot ? (
              <span aria-hidden className="size-6 shrink-0" />
            ) : null
          }
          className={cn(
            'mt-1 w-fit select-none',
            !latestResponse &&
              fork?.pendingItemId !== message.id &&
              'transition-opacity can-hover:pointer-events-none can-hover:opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100',
            // They hang into the gap below only when nothing left-side starts there. Never in a
            // section, which keeps them inside its border.
            actionsHang && '-mb-5'
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
    subagentGroups: content.subagentGroups,
    onOpenSubagent: props.onOpenSubagent,
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
