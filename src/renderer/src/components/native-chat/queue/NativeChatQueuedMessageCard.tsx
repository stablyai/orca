import { NativeChatQueuedMessageExpandToggle } from '@/components/native-chat/queue/NativeChatQueuedMessageExpandToggle'
import { QueuedMessageImageCount } from '@/components/native-chat/queue/NativeChatQueuedMessageImageCount'
import type { QueuedMessageDragPresentation } from '@/components/native-chat/queue/NativeChatQueuedMessageRows'
import { useId, useState } from 'react'
import {
  AlertCircle,
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
import { ShortcutKeyCombo } from '@/components/ui/ShortcutKeyCombo'
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
import { NativeChatTypedByQueuedLine } from '@/components/native-chat/NativeChatTypedByTag'
import { NativeChatPendingIcon } from '@/components/native-chat/queue/NativeChatPendingIcon'
import type { QueuedMessagesPendingAction } from '@/components/native-chat/queue/use-structured-agent-session-queued-messages'
import { useNativeChatClippedLine } from '@/components/native-chat/queue/use-native-chat-clipped-line'
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
      'Send now, while the agent keeps working'
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
  const caption = queuedMessageCardCaption(card, agentName, statedFailures, t)
  const line = queuedMessageCardLine(card, nativeChatImageLabelCopy(t))
  const returned = card.state === 'returned'
  const attention = queuedMessageCardNeedsAttention(card)
  const sendNow = queuedMessageCardSendNow(card, agentWorking, t)
  const busy = pending !== null
  const actionPending = pending === 'send' || pending === 'delete'
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
  const captionLine = caption ? (
    <p
      className={
        returned ? 'truncate text-xs text-destructive' : 'truncate text-xs text-muted-foreground'
      }
    >
      {attention && drag?.grip ? (
        <AlertCircle
          className="mr-1 inline size-3.5 align-text-bottom text-destructive"
          aria-hidden
        />
      ) : null}
      {caption}
    </p>
  ) : null
  const hasExpandedMetadata = expanded && (sender !== null || captionLine !== null)
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
  return (
    <li
      ref={drag?.rowRef}
      style={drag?.rowStyle}
      data-queued-message-id={card.messageId}
      data-queued-message-state={card.state}
      className={cn(
        'group/queued relative grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-1 py-1 pr-1 pl-2.5 hover:bg-accent/50 dark:hover:bg-accent/35',
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
      {hasExpandedMetadata ? (
        <div className="col-start-2">
          {sender}
          {captionLine}
        </div>
      ) : null}
      <span className="relative col-start-1 flex h-7 w-3.5 items-center justify-center">
        {attention && !drag?.grip ? (
          <AlertCircle className="size-3.5 text-destructive" aria-hidden />
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
      {/* Match the chevron gutter in both states and pad the expanded text viewport for focus rings. */}
      <div
        className={cn(
          'col-start-2 -mr-1 -mb-1 min-h-9 min-w-0 py-1 pr-1 [scrollbar-gutter:stable] [--queue-text-padding-top:max(var(--spacing),calc(var(--spacing)_*_6.5_-_1lh))]',
          !hasExpandedMetadata && '-mt-1',
          expanded ? 'scrollbar-sleek max-h-62 overflow-y-auto' : 'scrollbar-sleek overflow-hidden'
        )}
      >
        {/* The 6-unit buttons end 6.5 units down. Keep line two below them even at small text sizes. */}
        <div className="float-right mb-[calc(var(--queue-text-padding-top)_+_1lh_-_var(--spacing)_*_7)] ml-1 flex h-7 items-center text-sm">
          {card.images ? <QueuedMessageImageCount images={card.images} /> : null}
          {/* Nothing acts on a send still on its way: the host holds no card for it yet. */}
          {card.hold === 'sending' ? null : (
            <span
              className={cn(
                'flex items-center can-hover:pointer-events-none group-hover/queued:pointer-events-auto group-focus-within/queued:pointer-events-auto has-[[data-state=open]]:pointer-events-auto',
                // Keep visibility out of the buttons' transitions so only the pending indicator can show.
                actionPending
                  ? '[&>button]:transition-colors can-hover:group-[&:not(:hover,:focus-within)]/queued:not-has-[[data-state=open]]:[&>button]:invisible'
                  : 'can-hover:opacity-0 group-hover/queued:opacity-100 group-focus-within/queued:opacity-100 has-[[data-state=open]]:opacity-100'
              )}
            >
              {/* A command never steers: its Send shows only while the agent is idle. */}
              {card.waitsForAgent ? null : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant={showsSteerShortcut ? 'queued-head-steer' : 'ghost'}
                      size="xs"
                      onClick={onSteer}
                      disabled={steerHeld || busy}
                    >
                      <NativeChatPendingIcon
                        pending={pending === 'send'}
                        className="size-3"
                        showWhileHidden
                      >
                        {sendNow.steers ? (
                          <CornerDownRight className="size-3" />
                        ) : (
                          <Send className="size-3" />
                        )}
                      </NativeChatPendingIcon>
                      {sendNow.label}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={4}>
                    <span className="flex items-center gap-2">
                      <span>{sendNow.hint}</span>
                      {showsSteerShortcut ? (
                        <ShortcutKeyCombo
                          keys={isMac ? ['⌘', '⇧', '⏎'] : ['Ctrl', 'Shift', 'Enter']}
                        />
                      ) : null}
                    </span>
                  </TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t('components.native-chat.queuedMessages.delete', 'Delete')}
                    disabled={busy}
                    onClick={onDelete}
                  >
                    <NativeChatPendingIcon
                      pending={pending === 'delete'}
                      className="size-3.5"
                      showWhileHidden
                    >
                      <Trash2 className="size-3.5" />
                    </NativeChatPendingIcon>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>
                  {t('components.native-chat.queuedMessages.delete', 'Delete')}
                </TooltipContent>
              </Tooltip>
              {/* The host refuses these edits: a command would become a message, a run the owner's words. */}
              {!card.notEditable && onEdit ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
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
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem disabled={editDisabled} onSelect={onEdit}>
                      <Pencil />
                      {t('components.native-chat.queuedMessages.editMessage', 'Edit message')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </span>
          )}
          {/* Holds the header chevron's column even when there is nothing more to show. */}
          {expanded || clipped ? (
            <NativeChatQueuedMessageExpandToggle
              expanded={expanded}
              controls={expanded ? textId : undefined}
              onToggle={() => setExpanded(!expanded)}
            />
          ) : (
            <span aria-hidden className="size-6 shrink-0" />
          )}
        </div>
        {expanded ? null : sender}
        {expanded ? (
          <p
            id={textId}
            className="pt-(--queue-text-padding-top) pb-1 text-sm whitespace-pre-wrap wrap-anywhere"
            style={nativeChatTextHasUnkernedRun(line) ? NATIVE_CHAT_UNKERNED_CSS : undefined}
          >
            {line}
          </p>
        ) : (
          <p
            ref={measureLine}
            className="truncate pt-(--queue-text-padding-top) pb-1 text-sm"
            title={line}
          >
            {line}
          </p>
        )}
        {expanded ? null : captionLine}
      </div>
    </li>
  )
}
