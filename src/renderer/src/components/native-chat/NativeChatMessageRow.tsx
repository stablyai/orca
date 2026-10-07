import { memo, useCallback, useRef } from 'react'
import { NativeChatRewindAction } from './NativeChatRewindAction'
import type { NativeChatRewindSurface } from './use-native-chat-rewind'
import { Goal, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import { NativeChatMarkdown } from './NativeChatMarkdown'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type {
  NativeChatMessage,
  NativeChatToolCallBlock
} from '../../../../shared/native-chat-types'
import { deriveNativeChatRowContent } from '../../../../shared/native-chat-row-content'
import { NativeChatToolRun } from './NativeChatToolRun'
import { NativeChatReasoningRow } from './NativeChatReasoningRow'
import { NativeChatCodeBlock } from './NativeChatCodeBlock'
import { NativeChatNoticeRow } from './NativeChatNoticeRow'
import { nativeChatBlocksInOwnWords } from './native-chat-stopped-before-start-row'
import { NativeChatCopyButton } from './NativeChatCopyButton'
import { NativeChatMessageTimestamp } from './NativeChatMessageTimestamp'
import { NativeChatAgentMessageSenders } from './NativeChatAgentMessageSenders'
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
import { useNativeChatWorkRun } from './use-native-chat-work-run'

/** What a user message says about its delivery: that nothing has confirmed it yet, quietly in
 *  place of its time, or that it did not go through, with its own Retry when the surface can send
 *  it again. */
export type NativeChatDeliveryNotice =
  | { sending: true; text?: never; onRetry?: never; onDismiss?: never }
  | { sending?: never; text: string; onRetry?: () => void; onDismiss?: () => void }

const USER_META_REVEAL =
  'transition-opacity can-hover:pointer-events-none can-hover:opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 [.group:has(:focus-visible)_&]:pointer-events-auto [.group:has(:focus-visible)_&]:opacity-100'

/** Under a user message: copy + timestamp, revealed together like the agent controls row. Until
 *  confirmed, a quiet "Sending…" stays visible in the time's place and copy keeps its own reveal,
 *  so the row keeps its height when it clears. Image-only prompts have no text to copy. */
function UserMessageMeta({
  markdown,
  timestamp,
  sending,
  rewind
}: {
  markdown: string
  timestamp: number | null
  sending: boolean
  rewind?: { itemId: string; surface: NativeChatRewindSurface }
}): React.JSX.Element | null {
  if (!markdown && timestamp === null && !sending && !rewind) {
    return null
  }
  return (
    <div className={cn('flex select-none items-center gap-1', !sending && USER_META_REVEAL)}>
      {markdown ? (
        <NativeChatCopyButton text={markdown} className={sending ? USER_META_REVEAL : undefined} />
      ) : null}
      {sending ? (
        <span className="text-xs whitespace-nowrap text-chat-foreground-faint">
          {translate('components.native-chat.messageSending', 'Sending…')}
        </span>
      ) : (
        <NativeChatMessageTimestamp timestamp={timestamp} focusable />
      )}
      {rewind && !sending ? (
        <NativeChatRewindAction itemId={rewind.itemId} rewind={rewind.surface} />
      ) : null}
    </div>
  )
}

type MessageRowProps = {
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
  /** On a roster row: its list's state and the subagents whose rows open below it. */
  subagentRoster?: NativeChatSubagentRosterState
  subagentDisclosure?: NativeChatSubagentDisclosure
  /** Inside a subagent's section, whose border has to reach past the row's controls. */
  inSubagentSection?: boolean
  runtimeContext?: RuntimeFileOperationArgs | null
  /** On a user row: discards it and everything after it. */
  rewind?: NativeChatRewindSurface
  /** This row draws a run of tool calls and thoughts: every message in it, `message` first.
   *  The same row either way, so a row becoming a run keeps everything it has mounted. */
  workRun?: readonly NativeChatMessage[]
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
  subagentRoster,
  subagentDisclosure,
  inSubagentSection = false,
  runtimeContext,
  rewind,
  workRun
}: MessageRowProps): React.JSX.Element | null {
  const rowRef = useRef<HTMLDivElement | null>(null)
  const blocks = nativeChatBlocksInOwnWords(message.blocks)
  // One pass per block set, shared with the list that decides whether this row
  // occupies a slot — so "draws nothing" means the same thing to both.
  const { backgroundTasks, hasImages, markdown, prose, subagentGroups, tools } =
    deriveNativeChatRowContent(blocks)
  const isUser = message.role === 'user'
  const isReasoning = message.role === 'reasoning'
  const isSystem = message.role === 'system'
  const providerFrame = blocks.find((block) => block.type === 'text' && block.providerFrame)
  const run = useNativeChatWorkRun(workRun, {
    revealedDiff,
    activeTurnIsWorking,
    onLinkClick,
    allowFileUriLinks
  })

  const scrollToTop = useCallback(() => {
    if (rowRef.current) {
      onScrollMessageToTop(rowRef.current)
    }
  }, [onScrollMessageToTop])

  // Skip rows with nothing renderable so the transcript shows no empty/ghost
  // bubble.
  // After all hooks, so hook order stays unconditional.
  if (
    run === undefined &&
    markdown.length === 0 &&
    !hasImages &&
    tools.length === 0 &&
    subagentGroups.length === 0 &&
    backgroundTasks.length === 0
  ) {
    return null
  }

  const notice = isSystem
    ? blocks.find(
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
    // Another agent's message is the agent's turn input too, but is not the person's: it reads
    // left-aligned under its sender rather than as their bubble.
    const from = message.from
    return (
      <div
        ref={rowRef}
        className={cn('group relative flex flex-col gap-0.5', from ? 'items-start' : 'items-end')}
      >
        {from ? (
          <NativeChatAgentMessageSenders
            from={from}
            chatWorktreeId={runtimeContext?.worktreeId ?? null}
          />
        ) : null}
        {/* A distinct surface separates the user's prompt from the assistant's prose. */}
        <div
          className={cn(
            'max-w-[80%] text-sm native-chat-message-text',
            from
              ? 'select-text border-l-2 border-border/60 pl-3 text-chat-foreground'
              : 'rounded-xl border border-chat-user-border bg-chat-user-surface px-3.5 py-2.5 text-chat-foreground-strong'
          )}
        >
          {markdown ? (
            <>
              <NativeChatImageAttachments
                blocks={prose}
                runtimeContext={runtimeContext}
                enablePreview={runtimeContext !== undefined}
              />
              <NativeChatMarkdown
                content={markdown}
                variant="document"
                className="text-sm native-chat-message-text"
                renderCodeBlock={NativeChatCodeBlock}
                onLinkClick={onLinkClick}
                allowFileUriLinks={allowFileUriLinks}
                renderMath
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
        {message.sentAs === 'goal' ? (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Goal className="size-3" aria-hidden />
            <span>{translate('components.native-chat.goal.sentAsGoal', 'Sent as goal')}</span>
          </div>
        ) : null}
        <UserMessageMeta
          markdown={markdown}
          timestamp={message.timestamp}
          sending={deliveryNotice?.sending === true}
          {...(rewind ? { rewind: { itemId: message.id, surface: rewind } } : {})}
        />
        {deliveryNotice?.text !== undefined ? (
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

  if (isReasoning && run === undefined) {
    return (
      <div ref={rowRef}>
        <NativeChatReasoningRow
          message={message}
          turnIsWorking={activeTurnIsWorking}
          markdown={markdown}
          onLinkClick={onLinkClick}
          allowFileUriLinks={allowFileUriLinks}
        />
      </div>
    )
  }

  // A thought heading a run reads inside it, so the row has no words of its own.
  const words = isReasoning ? '' : markdown
  // Assistant controls reveal on hover and keyboard focus; system asides stay chrome-free.
  const showControls = !isSystem && words.length > 0

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
        <NativeChatMarkdown
          content={words}
          variant="document"
          className="text-sm native-chat-message-text"
          renderCodeBlock={NativeChatCodeBlock}
          onLinkClick={onLinkClick}
          allowFileUriLinks={allowFileUriLinks}
          linkifyFilePaths={onLinkClick !== undefined}
          renderMath
        />
      ) : null}
      {run || tools.length > 0 || subagentGroups.length > 0 || backgroundTasks.length > 0 ? (
        <NativeChatToolRun
          blocks={run?.blocks ?? tools}
          previousTodoWrite={previousTodoWrite}
          previousUpdatePlan={previousUpdatePlan}
          revealedDiff={run ? run.revealedDiff : revealedDiff}
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
          asides={run?.asides}
        />
      ) : null}
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
}, sameMessageRowProps)

/** A rebuilt transcript hands every run a fresh member list; same messages, same row. */
function sameMessageRowProps(previous: MessageRowProps, next: MessageRowProps): boolean {
  const { workRun: previousRun, ...previousRest } = previous
  const { workRun: nextRun, ...nextRest } = next
  const nextProps = new Map(Object.entries(nextRest))
  return (
    Object.keys(previousRest).length === nextProps.size &&
    Object.entries(previousRest).every(
      ([key, value]) => nextProps.has(key) && Object.is(value, nextProps.get(key))
    ) &&
    previousRun?.length === nextRun?.length &&
    (previousRun ?? []).every((member, index) => member === nextRun?.[index])
  )
}
