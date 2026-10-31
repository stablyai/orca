import { QueuedMessageImageCount } from './NativeChatQueuedMessageImageCount'
import type { QueuedMessageDragPresentation } from './NativeChatQueuedMessageRows'
import { useId, useState } from 'react'
import {
  AlertCircle,
  ChevronDown,
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
import { cn } from '@/lib/utils'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { translate } from '@/i18n/i18n'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'
import { QUEUED_MESSAGE_PAUSED_SEND_FAILED } from '../../../../shared/agent-session-wire'
import { isMacPlatform } from './native-chat-shortcut'
import {
  queuedMessageCardLine,
  queuedMessageCardNeedsAttention,
  queuedMessageCardSteers,
  queuedMessageReturnedNotice,
  type QueuedMessageCard
} from '../../../../shared/structured-agent-session-queued-cards'
import { NativeChatAgentMessageSenders } from './NativeChatAgentMessageSenders'
import { NativeChatPendingIcon } from './NativeChatPendingIcon'
import type { QueuedMessagesPendingAction } from './use-structured-agent-session-queued-messages'
import { useNativeChatClippedLine } from './use-native-chat-clipped-line'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import { NativeChatQueuedMessageComposer } from './NativeChatQueuedMessageComposer'
import type { QueuedEditAttachTarget } from './NativeChatQueuedMessageComposer'
import type { QueuedMessageInlineEditor } from './use-structured-agent-session-queued-edit'
import { nativeChatImageLabelCopy } from './native-chat-image-label'
import { NATIVE_CHAT_UNKERNED_CSS, nativeChatTextHasUnkernedRun } from './native-chat-unkerned-runs'

/** The visible caption under the text; the default waiting hold needs none. */
export function queuedMessageCardCaption(
  card: QueuedMessageCard,
  agentName?: string,
  statedFailures: readonly AgentSessionFailureFact[] = []
): string | null {
  switch (card.hold) {
    case 'returned': {
      const notice = queuedMessageReturnedNotice(card, agentName, statedFailures)
      return notice === 'withdrawn'
        ? translate(
            'components.native-chat.queuedMessages.withdrawnHold',
            'Stopped before it was sent'
          )
        : agentSessionWriteNoticeText(notice)
    }
    case 'paused':
      // Localize known pause markers; unknown newer-host markers fall back to a plain pause.
      if (card.pausedReason === QUEUED_MESSAGE_PAUSED_SEND_FAILED) {
        // Its Send shows only while the agent is idle; the words match what is on the card.
        return card.waitsForAgent
          ? translate(
              'components.native-chat.queuedMessages.pausedSendFailedWaiting',
              "Couldn't send — press Send to retry once the agent finishes."
            )
          : translate(
              'components.native-chat.queuedMessages.pausedSendFailed',
              "Couldn't send — press Send to retry."
            )
      }
      return translate('components.native-chat.queuedMessages.paused', 'Paused')
    case 'behind-returned':
      return translate(
        'components.native-chat.queuedMessages.behindReturnedHold',
        'Waiting — a message ahead needs attention'
      )
    case 'sending':
      return translate('components.native-chat.messageSending', 'Sending…')
    case 'turn':
    case 'queue-paused':
      // Plainly queued; a paused queue's header row carries the why.
      return null
  }
}

/** Steer's or Send's label and tooltip: Steer only into a turn that is running (`queuedMessageCardSteers`). */
export function queuedMessageCardSendNow(
  card: QueuedMessageCard,
  agentWorking: boolean
): {
  /** Steer's ↳, or Send's paper plane. */
  steers: boolean
  label: string
  hint: string
} {
  if (!agentWorking || !queuedMessageCardSteers(card)) {
    return {
      steers: false,
      label: translate('components.native-chat.queuedMessages.send', 'Send'),
      hint: translate('components.native-chat.queuedMessages.sendHint', 'Send this message now')
    }
  }
  return {
    steers: true,
    label: translate('components.native-chat.queuedMessages.steer', 'Steer'),
    hint: translate(
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
  const caption = queuedMessageCardCaption(card, agentName, statedFailures)
  const line = queuedMessageCardLine(card, nativeChatImageLabelCopy())
  const returned = card.state === 'returned'
  const attention = queuedMessageCardNeedsAttention(card)
  const sendNow = queuedMessageCardSendNow(card, agentWorking)
  const busy = pending !== null
  const isMac = isMacPlatform()
  // Allow inspecting clipped text before acting; another agent may have authored the card.
  const [expanded, setExpanded] = useState(false)
  const [clipped, measureLine] = useNativeChatClippedLine(false)
  const textId = useId()
  const sender = card.from ? (
    <NativeChatAgentMessageSenders from={card.from} chatWorktreeId={chatWorktreeId} queued />
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
  return (
    <li
      ref={drag?.rowRef}
      style={drag?.rowStyle}
      data-queued-message-id={card.messageId}
      data-queued-message-state={card.state}
      className="group/queued relative px-2.5 py-1.5"
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
      <div className="flex items-center gap-1">
        <span className="relative flex size-3.5 shrink-0 items-center justify-center">
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
        <div className="min-w-0 flex-1">
          {sender}
          {expanded ? null : (
            <p ref={measureLine} className="truncate text-sm" title={line}>
              {line}
            </p>
          )}
          {caption ? (
            <p
              className={
                returned
                  ? 'truncate text-xs text-destructive'
                  : 'truncate text-xs text-muted-foreground'
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
          ) : null}
        </div>
        {card.images ? <QueuedMessageImageCount images={card.images} /> : null}
        {expanded || clipped ? (
          <QueuedMessageExpandToggle
            expanded={expanded}
            controls={expanded ? textId : undefined}
            onToggle={() => setExpanded(!expanded)}
          />
        ) : null}
        {/* Nothing acts on a send still on its way: the host holds no card for it yet. */}
        {card.hold === 'sending' ? null : (
          <>
            {/* A command never steers: its Send shows only while the agent is idle. */}
            {card.waitsForAgent ? null : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
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
                  aria-label={translate('components.native-chat.queuedMessages.delete', 'Delete')}
                  disabled={busy}
                  onClick={onDelete}
                >
                  <NativeChatPendingIcon pending={pending === 'delete'} className="size-3.5">
                    <Trash2 className="size-3.5" />
                  </NativeChatPendingIcon>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {translate('components.native-chat.queuedMessages.delete', 'Delete')}
              </TooltipContent>
            </Tooltip>
            {/* A command's text is not a draft: edited, it would become a message. */}
            {!card.command && onEdit ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={translate(
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
                    {translate('components.native-chat.queuedMessages.editMessage', 'Edit message')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </>
        )}
      </div>
      {expanded ? (
        <p
          id={textId}
          className="scrollbar-sleek mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap break-words pl-5.5 text-sm"
          style={nativeChatTextHasUnkernedRun(line) ? NATIVE_CHAT_UNKERNED_CSS : undefined}
        >
          {line}
        </p>
      ) : null}
    </li>
  )
}

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
  const label = expanded
    ? translate('components.native-chat.queuedMessages.showLess', 'Show less')
    : translate('components.native-chat.queuedMessages.showFullMessage', 'Show full message')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          aria-expanded={expanded}
          aria-controls={controls}
          onClick={onToggle}
        >
          <ChevronDown
            className={cn(
              'size-3.5 transition-transform motion-reduce:transition-none',
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
