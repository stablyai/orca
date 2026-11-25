import {
  queuedMessageCardCaption,
  queuedMessageCardSendNow
} from './native-chat-queued-message-presentation'
import { NativeChatSignInButton, NativeChatSignInRow } from '../host-access/NativeChatSignInRow'
import { useNativeChatHostSetupView } from '../host-access/native-chat-host-setup-view'
import {
  nativeChatNotSignedInSentence,
  nativeChatSignInNoticeView
} from '../host-access/native-chat-sign-in-notice'
import { useNativeChatSignInCandidate } from '../host-access/use-native-chat-sign-in-visibility'
import { QueuedMessageImageCount } from '@/components/native-chat/queue/NativeChatQueuedMessageImageCount'
import type { QueuedMessageDragPresentation } from '@/components/native-chat/queue/NativeChatQueuedMessageRows'
import { useId, useRef, useState } from 'react'
import {
  AlertCircle,
  ChevronDown,
  CornerDownRight,
  ListEnd,
  Pencil,
  Send,
  Trash2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import { ShortcutKeyCombo } from '@/components/ui/ShortcutKeyCombo'
import { useTranslate } from '@/i18n/use-translate'
import { isMacPlatform } from '@/components/native-chat/pane/routing/native-chat-shortcut'
import {
  queuedMessageCardLine,
  queuedMessageCardNeedsAttention,
  type QueuedMessageCard
} from '../../../../../shared/agent-session/view/structured-agent-session-queued-cards'
import { NativeChatAgentMessageSenders } from '@/components/native-chat/messages/agent-senders/NativeChatAgentMessageSenders'
import { NativeChatTypedByQueuedLine } from '@/components/native-chat/NativeChatTypedByTag'
import { NativeChatPendingIcon } from '@/components/native-chat/queue/NativeChatPendingIcon'
import type { QueuedMessagesPendingAction } from '@/components/native-chat/queue/use-structured-agent-session-queued-messages'
import { useNativeChatClippedLine } from '@/components/native-chat/queue/use-native-chat-clipped-line'
import {
  QUEUED_ROW_REVEAL,
  QUEUED_ROW_INSET_VAR,
  QUEUED_ROW_TARGET,
  QueuedMessageRowTool,
  queuedRowToolsMask
} from '@/components/native-chat/queue/NativeChatQueuedMessageRowTools'
import {
  readAgentSessionFailureFact,
  type AgentSessionFailureFact
} from '../../../../../shared/agent-session/failures/agent-session-failure'
import {
  NativeChatQueuedMessageComposer,
  type QueuedEditAttachTarget
} from '@/components/native-chat/queue/editing/NativeChatQueuedMessageComposer'
import type { QueuedMessageInlineEditor } from '@/components/native-chat/queue/editing/native-chat-queued-edit-session'
import { nativeChatImageLabelCopy } from '@/components/native-chat/media/images/native-chat-image-label'
import {
  NATIVE_CHAT_UNKERNED_CSS,
  nativeChatTextHasUnkernedRun
} from '@/components/native-chat/composer/editor/native-chat-unkerned-runs'

export function NativeChatQueuedMessageCard({
  card,
  chatWorktreeId,
  agentName,
  statedFailures,
  showsSteerShortcut,
  agentWorking,
  steerHeld = false,
  pending = null,
  onSteer,
  onDelete,
  onEdit,
  editor,
  editAttachTo,
  editDisabled = false,
  drag
}: {
  card: QueuedMessageCard
  /** The chat's worktree, whose host its sender is found on; null shows the sender unlinked. */
  chatWorktreeId: string | null
  agentName?: string
  statedFailures?: readonly AgentSessionFailureFact[]
  /** Only the head card answers Cmd/Ctrl+Shift+Enter; only it may show the chord. */
  showsSteerShortcut: boolean
  /** The agent is working: a steerable card's action reads Steer, otherwise Send. */
  agentWorking: boolean
  /** The chat reads Stopping: the card waits for the stop (`NativeChatQueuedMessageList`). */
  steerHeld?: boolean
  /** Disable the card during its own action or Clear all; spin only the pressed action. */
  pending?: QueuedMessagesPendingAction | null
  onSteer: () => void
  onDelete: () => void
  /** Absent when the host cannot edit in place: the card then offers no Edit at all. */
  onEdit?: () => void
  /** This card is being edited here: the editor replaces its text and its actions. */
  editor?: QueuedMessageInlineEditor
  /** The chat files added in the editor attach to. */
  editAttachTo?: QueuedEditAttachTarget
  /** Another card in this pane is being edited. */
  editDisabled?: boolean
  drag?: QueuedMessageDragPresentation
}): React.JSX.Element {
  const t = useTranslate()
  const failure = readAgentSessionFailureFact(card.returnedRejection)
  const auth = card.state === 'returned' && failure?.kind === 'notSignedIn'
  const setup = useNativeChatHostSetupView()
  const signIn = nativeChatSignInNoticeView(
    {
      kind: auth ? 'notSignedIn' : undefined,
      agent: agentName,
      account: failure?.kind === 'notSignedIn' ? failure.account : undefined,
      setup
    },
    t
  )
  const signInAnchor = useRef<HTMLSpanElement>(null)
  const selected = useNativeChatSignInCandidate(
    'queue',
    card.messageId,
    Boolean(auth && signIn && !setup?.resolved && !editor),
    signInAnchor
  )
  const showsSignIn = Boolean(signIn && !setup?.resolved && !setup?.signInInComposer && selected)
  const authRecovery = auth && signIn !== null
  const caption = queuedMessageCardCaption(card, agentName, statedFailures, t)
  const line = queuedMessageCardLine(card, nativeChatImageLabelCopy(t))
  const returned = card.state === 'returned'
  const attention = queuedMessageCardNeedsAttention(card)
  const failed = !auth && attention && caption !== null
  const sendNow = queuedMessageCardSendNow(card, agentWorking, t)
  const busy = pending !== null
  const editLabel = t('components.native-chat.queuedMessages.editMessage', 'Edit message')
  const isMac = isMacPlatform()
  // Allow inspecting clipped text before acting; another agent may have authored the card.
  const [expanded, setExpanded] = useState(false)
  const [clipped, measureLine] = useNativeChatClippedLine(false)
  const textId = useId()
  const sender = card.from ? (
    <NativeChatAgentMessageSenders from={card.from} chatWorktreeId={chatWorktreeId} queued />
  ) : card.typedByOther ? (
    <NativeChatTypedByQueuedLine typist={card.typedByOther} />
  ) : null
  if (editor) {
    return (
      // The editor fills the row, so a drop anywhere on the card reaches it.
      <li data-queued-message-id={card.messageId} data-queued-message-state={card.state}>
        <NativeChatQueuedMessageComposer
          editor={editor}
          attachTo={editAttachTo}
          sender={sender}
          images={card.images ? <QueuedMessageImageCount images={card.images} /> : null}
        />
      </li>
    )
  }
  // Nothing acts on a send still on its way: the host holds no card for it yet.
  const actionable = card.hold !== 'sending'
  // The host refuses these edits: a command would become a message, a run the owner's words.
  const editable = actionable && !card.notEditable && onEdit !== undefined
  // Edit and Delete wait for hover or keyboard focus; Steer stays on every row.
  const toolCount = actionable && !authRecovery ? (editable ? 2 : 1) : 0
  const maskStyle: (React.CSSProperties & { '--queued-tools-mask': string }) | undefined =
    toolCount > 0 ? { '--queued-tools-mask': queuedRowToolsMask(toolCount) } : undefined
  const tools = actionable ? (
    <>
      {editable &&
        (authRecovery ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={busy || editDisabled}
            onClick={onEdit}
          >
            <Pencil className="size-3.5" />
            {editLabel}
          </Button>
        ) : (
          <QueuedMessageRowTool label={editLabel} disabled={busy || editDisabled} onClick={onEdit}>
            <Pencil className="size-3.5" />
          </QueuedMessageRowTool>
        ))}
      <QueuedMessageRowTool
        label={t('components.native-chat.queuedMessages.delete', 'Delete')}
        disabled={busy}
        onClick={onDelete}
      >
        <NativeChatPendingIcon pending={pending === 'delete'} className="size-3.5">
          <Trash2 className="size-3.5" />
        </NativeChatPendingIcon>
      </QueuedMessageRowTool>
    </>
  ) : null
  // The recovery row has no inline-row inset to pull Steer's glyph toward.
  const steerGlyph = authRecovery ? 'size-3' : STEER_GLYPH
  const sendButton =
    actionable && !card.waitsForAgent ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant={showsSteerShortcut ? 'queued-head-steer' : 'ghost'}
            size="xs"
            className="min-h-[24px] min-w-[24px]"
            data-queued-message-send
            onClick={onSteer}
            disabled={steerHeld || busy}
          >
            <NativeChatPendingIcon pending={pending === 'send'} className={steerGlyph}>
              {failed && drag?.grip ? (
                <AlertCircle className={cn(steerGlyph, 'text-destructive')} />
              ) : sendNow.steers ? (
                <CornerDownRight className={steerGlyph} />
              ) : (
                <Send className={steerGlyph} />
              )}
            </NativeChatPendingIcon>
            {failed ? t('components.native-chat.queuedMessages.retry', 'Retry') : sendNow.label}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          <span className="flex items-center gap-2">
            <span>{failed ? caption : sendNow.hint}</span>
            {showsSteerShortcut ? (
              <ShortcutKeyCombo keys={isMac ? ['⌘', '⇧', '⏎'] : ['Ctrl', 'Shift', 'Enter']} />
            ) : null}
          </span>
        </TooltipContent>
      </Tooltip>
    ) : null
  return (
    <li
      ref={drag?.rowRef}
      style={drag?.rowStyle}
      data-queued-message-id={card.messageId}
      data-queued-message-state={card.state}
      // Touch has no hover: a tap focuses the row, and focus-within reveals its tools there only, so a mouse click never pins them.
      tabIndex={-1}
      className={cn(
        'group/queued relative px-2.5 py-1.5 outline-none',
        // Lit while the chat's composer shows Steer queued: the card that press would send.
        showsSteerShortcut &&
          '[[data-native-chat-root]:has([data-native-chat-steer-preview=steer-queued])_&]:bg-accent'
      )}
    >
      {drag?.insertion ? (
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-x-0 h-0.5 bg-primary',
            drag.insertion === 'before' ? 'top-0' : 'bottom-0'
          )}
        />
      ) : null}
      <div className={cn('flex items-center gap-1', authRecovery && 'flex-wrap')}>
        {!authRecovery || drag?.grip ? (
          <span className="relative flex size-3.5 shrink-0 items-center justify-center">
            {attention && !authRecovery && !drag?.grip ? (
              <AlertCircle className="size-3.5 text-destructive" aria-hidden />
            ) : (
              <ListEnd
                className={cn(
                  'size-3.5 text-muted-foreground',
                  drag?.grip &&
                    'group-hover/queued:opacity-0 group-has-[:focus-visible]/queued:opacity-0 [@media(hover:none)]:opacity-0'
                )}
                aria-hidden
              />
            )}
            {drag?.grip}
          </span>
        ) : null}
        <div
          className={cn(
            'min-w-0 flex-1',
            // The line fades out under the revealed tools; shown while acting, so a pressed tool never vanishes.
            toolCount > 0 &&
              (busy
                ? '[mask-image:var(--queued-tools-mask)]'
                : 'group-hover/queued:[mask-image:var(--queued-tools-mask)] group-has-[:focus-visible]/queued:[mask-image:var(--queued-tools-mask)] [@media(hover:none)]:group-focus-within/queued:[mask-image:var(--queued-tools-mask)]')
          )}
          style={maskStyle}
        >
          {sender}
          {expanded ? null : (
            <p ref={measureLine} className="truncate text-sm text-foreground" title={line}>
              {line}
            </p>
          )}
          {authRecovery && signIn ? (
            <NativeChatSignInRow
              view={{ ...signIn, button: null }}
              sentence={nativeChatNotSignedInSentence(agentName ?? 'the agent', t)}
              surface="composer"
            />
          ) : caption ? (
            <p
              className={cn(
                'truncate text-xs',
                returned ? 'text-destructive' : 'text-muted-foreground',
                failed && !card.waitsForAgent && 'can-hover:pointer-fine:@max-[400px]:sr-only'
              )}
            >
              {attention && drag?.grip ? (
                <AlertCircle
                  className="mr-1 inline size-3.5 align-text-bottom text-destructive"
                  aria-hidden
                />
              ) : null}
              {caption}
            </p>
          ) : null}
        </div>
        {/* Each glyph's own box spacing (an icon button's 5px, the image count's padding) sets the even
            rhythm. A 1px seam separates every target, the hover-revealed tools included: at a fractional x
            the browser hit-tests a point up to 1px left of a box, so flush targets each lose a sliver. */}
        <div className={cn('relative flex shrink-0 items-center gap-px', QUEUED_ROW_INSET_VAR)}>
          {toolCount > 0 ? (
            <div
              className={cn(
                'absolute inset-y-0 right-[calc(100%+1px)] flex items-center gap-px transition-opacity motion-reduce:transition-none',
                !busy && QUEUED_ROW_REVEAL
              )}
            >
              {tools}
            </div>
          ) : null}
          {card.images ? (
            <QueuedMessageImageCount
              images={card.images}
              // 1px less after the digit, whose own side bearing already widens the gap to the chevron.
              className={cn(
                'h-6 rounded-md pr-[calc(var(--queued-row-inset)-1px)] pl-(--queued-row-inset)',
                QUEUED_ROW_TARGET
              )}
            />
          ) : null}
          {expanded || clipped ? (
            <QueuedMessageExpandToggle
              expanded={expanded}
              controls={expanded ? textId : undefined}
              onToggle={() => setExpanded(!expanded)}
            />
          ) : null}
          {/* Every row keeps its own Steer at rest, since each sends that one message. A command never
              steers: its Send shows only while the agent is idle. */}
          {!authRecovery ? sendButton : null}
        </div>
        {authRecovery ? (
          <div className="flex w-full flex-wrap items-center gap-2">
            {/* Observe the Sign in control itself: a wrapped group can be partly visible while it is clipped. */}
            <span ref={signInAnchor} className="flex shrink-0 empty:-mr-2">
              {showsSignIn && signIn?.button ? (
                <NativeChatSignInButton button={signIn.button} />
              ) : null}
            </span>
            {sendButton}
            {tools}
          </div>
        ) : null}
      </div>
      {expanded ? (
        <p
          id={textId}
          className="scrollbar-sleek mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap break-words pl-5.5 text-sm text-foreground"
          style={nativeChatTextHasUnkernedRun(line) ? NATIVE_CHAT_UNKERNED_CSS : undefined}
        >
          {line}
        </p>
      ) : null}
    </li>
  )
}

// Steer's glyphs start with their own blank edge: pulled in to the icon buttons' inset (from the
// button's 6px), the gap before them matches the row's other gaps.
const STEER_GLYPH = 'size-3 ml-[calc(var(--queued-row-inset)-var(--spacing)*1.5)]'

function QueuedMessageExpandToggle({
  expanded,
  controls,
  onToggle
}: {
  expanded: boolean
  /** The opened text element; absent while folded, when no such element exists. */
  controls: string | undefined
  onToggle: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const label = expanded
    ? t('components.native-chat.queuedMessages.showLess', 'Show less')
    : t('components.native-chat.queuedMessages.showFullMessage', 'Show full message')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="min-h-[24px] min-w-[24px]"
          aria-label={label}
          aria-expanded={expanded}
          aria-controls={controls}
          onClick={onToggle}
        >
          {/* The row's narrowest glyph: at size-4 its full 24px box leaves the same gaps as its neighbors'. */}
          <ChevronDown
            className={cn(
              'size-4 transition-transform motion-reduce:transition-none',
              expanded && 'rotate-180'
            )}
          />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

export { queuedMessageCardCaption } from './native-chat-queued-message-presentation'
