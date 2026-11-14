import { QueuedMessageImageCount } from '@/components/native-chat/queue/NativeChatQueuedMessageImageCount'
import type { QueuedMessageDragPresentation } from '@/components/native-chat/queue/NativeChatQueuedMessageRows'
import { useId } from 'react'
import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  CornerDownRight,
  ListEnd,
  MoreHorizontal,
  Pencil,
  Send,
  Trash2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { agentSessionWriteNoticeText } from '@/components/native-chat/messages/notices/agent-session-write-notice-text'
import { QUEUED_MESSAGE_PAUSED_SEND_FAILED } from '../../../../../shared/agent-session/requests/agent-session-queued-message-wire'
import { isMacPlatform } from '@/components/native-chat/pane/routing/native-chat-shortcut'
import {
  queuedMessageCardLine,
  queuedMessageCardNeedsAttention,
  queuedMessageCardSteers,
  queuedMessageReturnedNotice,
  type QueuedMessageCard
} from '../../../../../shared/agent-session/view/structured-agent-session-queued-cards'
import { NativeChatAgentMessageSenders } from '@/components/native-chat/messages/agent-senders/NativeChatAgentMessageSenders'
import { NativeChatPendingIcon } from '@/components/native-chat/queue/NativeChatPendingIcon'
import type { QueuedMessagesPendingAction } from '@/components/native-chat/queue/use-structured-agent-session-queued-messages'
import type { AgentSessionFailureFact } from '../../../../../shared/agent-session/failures/agent-session-failure'
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

/** The visible caption under the text; the default waiting hold needs none. */
export function queuedMessageCardCaption(
  card: QueuedMessageCard,
  agentName?: string,
  statedFailures: readonly AgentSessionFailureFact[] = [],
  t: Translate = translate
): string | null {
  switch (card.hold) {
    case 'returned': {
      const notice = queuedMessageReturnedNotice(card, agentName, statedFailures)
      if (notice === null) {
        return null
      }
      return notice === 'withdrawn'
        ? t('components.native-chat.queuedMessages.withdrawnHold', 'Stopped before it was sent')
        : agentSessionWriteNoticeText(notice)
    }
    case 'paused':
      // Localize known pause markers; unknown newer-host markers fall back to a plain pause.
      if (card.pausedReason === QUEUED_MESSAGE_PAUSED_SEND_FAILED) {
        // Its Send shows only while the agent is idle; the words match what is on the card.
        return card.waitsForAgent
          ? t(
              'components.native-chat.queuedMessages.pausedSendFailedWaiting',
              "Couldn't send — press Send to retry once the agent finishes."
            )
          : t(
              'components.native-chat.queuedMessages.pausedSendFailed',
              "Couldn't send — press Send to retry."
            )
      }
      return t('components.native-chat.queuedMessages.paused', 'Paused')
    case 'sending':
      return t('components.native-chat.messageSending', 'Sending…')
    case 'turn':
    case 'queue-paused':
      // Plainly queued; a paused queue's header row carries the why.
      return null
  }
}

/** Steer's or Send's label and tooltip: Steer only into a turn that is running (`queuedMessageCardSteers`). */
export function queuedMessageCardSendNow(
  card: QueuedMessageCard,
  agentWorking: boolean,
  t: Translate = translate
): {
  /** Steer's ↳, or Send's paper plane. */
  steers: boolean
  label: string
  hint: string
} {
  if (!agentWorking || !queuedMessageCardSteers(card)) {
    return {
      steers: false,
      label: t('components.native-chat.queuedMessages.send', 'Send'),
      hint: t('components.native-chat.queuedMessages.sendHint', 'Send this message now')
    }
  }
  return {
    steers: true,
    label: t('components.native-chat.queuedMessages.steer', 'Steer'),
    hint: t(
      'components.native-chat.queuedMessages.steerHint',
      'Submit without interrupting the model'
    )
  }
}

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
  expanded = false,
  onToggleExpanded,
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
  /** The full message shows in place of the one-line row (the list caps rows by count). */
  expanded?: boolean
  onToggleExpanded?: () => void
  /** This card is being edited here: the editor replaces its text and its actions. */
  editor?: QueuedMessageInlineEditor
  /** The chat files added in the editor attach to. */
  editAttachTo?: QueuedEditAttachTarget
  /** Another card in this pane is being edited. */
  editDisabled?: boolean
  drag?: QueuedMessageDragPresentation
}): React.JSX.Element {
  const t = useTranslate()
  const caption = queuedMessageCardCaption(card, agentName, statedFailures, t)
  const line = queuedMessageCardLine(card, nativeChatImageLabelCopy(t))
  const attention = queuedMessageCardNeedsAttention(card)
  // Only a stated failure reads as one: an unconfirmed delivery has no notice, so no "Couldn't send".
  const failed = attention && caption !== null
  const sendNow = queuedMessageCardSendNow(card, agentWorking, t)
  const busy = pending !== null
  const isMac = isMacPlatform()
  const textId = useId()
  const withdrawn =
    card.hold === 'returned' &&
    queuedMessageReturnedNotice(card, agentName, statedFailures ?? []) === 'withdrawn'
  // Another agent may have authored the card: its full text is one click away before acting.
  const toggleLabel = expanded
    ? t('components.native-chat.queuedMessages.showLess', 'Show less')
    : t('components.native-chat.queuedMessages.showFullMessage', 'Show full message')
  if (editor) {
    return (
      // The editor fills the row, so a drop anywhere on the card reaches it.
      <li data-queued-message-id={card.messageId} data-queued-message-state={card.state}>
        <NativeChatQueuedMessageComposer
          editor={editor}
          attachTo={editAttachTo}
          sender={
            card.from ? (
              <NativeChatAgentMessageSenders
                from={card.from}
                chatWorktreeId={chatWorktreeId}
                queued
              />
            ) : null
          }
          images={card.images ? <QueuedMessageImageCount images={card.images} /> : null}
        />
      </li>
    )
  }
  return (
    <li
      ref={drag?.rowRef}
      style={drag?.rowStyle}
      data-queued-message-id={card.messageId}
      data-queued-message-state={card.state}
      className={cn(
        'group/queued relative flex gap-2 rounded-lg pr-0.5 pl-1.5 hover:bg-foreground/5',
        expanded ? 'items-start py-1' : 'h-(--queued-row) items-center',
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
      <span
        className={cn(
          'relative flex size-3.5 shrink-0 items-center justify-center',
          expanded && 'mt-1.5'
        )}
      >
        {attention ? (
          <AlertCircle
            className={cn(
              'size-3.5 text-destructive',
              drag?.grip &&
                'group-hover/queued:opacity-0 group-focus-within/queued:opacity-0 [@media(hover:none)]:opacity-0'
            )}
            aria-hidden
          />
        ) : (
          <ListEnd
            className={cn(
              'size-3.5 text-muted-foreground',
              drag?.grip &&
                'group-hover/queued:opacity-0 group-focus-within/queued:opacity-0 [@media(hover:none)]:opacity-0'
            )}
            aria-hidden
          />
        )}
        {drag?.grip}
      </span>
      <button
        type="button"
        id={textId}
        aria-expanded={expanded}
        aria-label={expanded ? undefined : line}
        title={expanded ? undefined : line}
        onClick={onToggleExpanded}
        className={cn(
          'min-w-0 flex-1 rounded-sm text-left text-sm text-foreground focus-visible:outline-[1.5px] focus-visible:outline-offset-1 focus-visible:outline-foreground/45',
          expanded
            ? 'scrollbar-sleek max-h-60 overflow-y-auto py-0.5 whitespace-pre-wrap break-words'
            : 'truncate'
        )}
        style={
          expanded && nativeChatTextHasUnkernedRun(line) ? NATIVE_CHAT_UNKERNED_CSS : undefined
        }
      >
        {line}
      </button>
      {failed ? (
        // Never truncated: the reason a row needs the person comes first; the full words are in its tooltip.
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              tabIndex={0}
              className={cn(
                'shrink-0 rounded-sm text-xs font-medium whitespace-nowrap text-destructive focus-visible:outline-[1.5px] focus-visible:outline-foreground/45',
                expanded && 'mt-1'
              )}
            >
              {withdrawn
                ? caption
                : t('components.native-chat.queuedMessages.couldNotSend', "Couldn't send")}
              {withdrawn ? null : <span className="sr-only">{`: ${caption}`}</span>}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {caption}
          </TooltipContent>
        </Tooltip>
      ) : caption ? (
        <span
          className="max-w-[20%] shrink-0 truncate text-xs text-muted-foreground"
          title={caption}
        >
          {caption}
        </span>
      ) : card.from ? (
        <span className="max-w-[20%] min-w-0 shrink-0 @max-[460px]:hidden">
          <NativeChatAgentMessageSenders from={card.from} chatWorktreeId={chatWorktreeId} inline />
        </span>
      ) : null}
      {card.images ? <QueuedMessageImageCount images={card.images} /> : null}
      {/* Nothing acts on a send still on its way: the host holds no card for it yet. */}
      {card.hold === 'sending' ? null : (
        <span className="flex shrink-0 items-center gap-px">
          {/* A command never steers: its Send shows only while the agent is idle. */}
          {card.waitsForAgent ? null : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant={showsSteerShortcut ? 'queued-head-steer' : 'queued-row-action'}
                  size="row-action"
                  onClick={onSteer}
                  disabled={steerHeld || busy}
                >
                  <NativeChatPendingIcon pending={pending === 'send'} className="size-3">
                    {sendNow.steers ? (
                      <CornerDownRight className="size-3" />
                    ) : (
                      <Send className="size-3" />
                    )}
                  </NativeChatPendingIcon>
                  {failed
                    ? t('components.native-chat.queuedMessages.retry', 'Retry')
                    : sendNow.label}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                <span className="flex items-center gap-2">
                  <span>{sendNow.hint}</span>
                  {showsSteerShortcut ? (
                    <ShortcutKeyCombo keys={isMac ? ['⌘', '⇧', '⏎'] : ['Ctrl', 'Shift', 'Enter']} />
                  ) : null}
                </span>
              </TooltipContent>
            </Tooltip>
          )}
          {/* Shown on hover or focus; always on touch screens and on a row that needs attention. */}
          <span
            className={cn(
              'inline-flex transition-opacity',
              !attention &&
                'opacity-0 group-focus-within/queued:opacity-100 group-hover/queued:opacity-100 [@media(hover:none)]:opacity-100'
            )}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="muted-field-icon"
                  size="icon-xs"
                  aria-label={t('components.native-chat.queuedMessages.delete', 'Delete')}
                  disabled={busy}
                  onClick={onDelete}
                >
                  <NativeChatPendingIcon pending={pending === 'delete'} className="size-3.5">
                    <Trash2 className="size-3.5" />
                  </NativeChatPendingIcon>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {t('components.native-chat.queuedMessages.delete', 'Delete')}
              </TooltipContent>
            </Tooltip>
          </span>
          {/* The menu portals, so the list's scroll box never clips it. */}
          <DropdownMenu>
            <span className="inline-flex opacity-70 transition-opacity focus-within:opacity-100 hover:opacity-100 has-[[data-state=open]]:opacity-100">
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="muted-field-icon"
                  size="icon-xs"
                  aria-label={t(
                    'components.native-chat.queuedMessages.moreActions',
                    'More actions'
                  )}
                  disabled={busy}
                >
                  <MoreHorizontal className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
            </span>
            <DropdownMenuContent align="end">
              {/* A command's text is not a draft: edited, it would become a message. */}
              {!card.command && onEdit ? (
                <DropdownMenuItem disabled={editDisabled} onSelect={onEdit}>
                  <Pencil />
                  {t('components.native-chat.queuedMessages.editMessage', 'Edit message')}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onSelect={onToggleExpanded}>
                {expanded ? <ChevronUp /> : <ChevronDown />}
                {toggleLabel}
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                <Trash2 />
                {t('components.native-chat.queuedMessages.delete', 'Delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      )}
    </li>
  )
}
