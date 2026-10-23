import { useId, useState } from 'react'
import {
  AlertCircle,
  ChevronDown,
  CornerDownRight,
  Image as ImageIcon,
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
import { structuredAgentSessionAttemptFailureParts } from '../../../../shared/structured-agent-session-rejection-words'
import { classifyDispatchRejection } from '../../../../shared/structured-agent-session-dispatch-rejection'
import { readWholeAgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'
import { QUEUED_MESSAGE_PAUSED_SEND_FAILED } from '../../../../shared/agent-session-wire'
import { isMacPlatform } from './native-chat-shortcut'
import {
  queuedMessageCardSteers,
  type QueuedMessageCard
} from './structured-agent-session-queued-cards'
import { NativeChatAgentMessageSenders } from './NativeChatAgentMessageSenders'
import { NativeChatPendingIcon } from './NativeChatPendingIcon'
import type { QueuedMessagesPendingAction } from './use-structured-agent-session-queued-messages'
import { useNativeChatClippedLine } from './use-native-chat-clipped-line'
import { agentSessionFailureStatedByStartRow } from './structured-agent-session-delivery-notices'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import { agentSessionWriteNotDoneParts } from '../../../../shared/agent-session-refusal-notice'
import { NativeChatQueuedMessageEditor } from './NativeChatQueuedMessageEditor'
import type { QueuedEditAttachTarget } from './use-native-chat-queued-edit-image-intake'
import type { QueuedMessageInlineEditor } from './use-structured-agent-session-queued-edit'
import { nativeChatImageLabel } from './native-chat-image-label'

/** The visible caption under the text; the default waiting hold needs none. */
export function queuedMessageCardCaption(
  card: QueuedMessageCard,
  agentName?: string,
  statedFailures: readonly AgentSessionFailureFact[] = []
): string | null {
  switch (card.hold) {
    case 'returned': {
      // Read exactly as a rejected submission: the typed fact decides, the reason is the fallback.
      const reason = card.returnedReason ?? null
      if (agentSessionFailureStatedByStartRow(card.returnedRejection, statedFailures)) {
        return agentSessionWriteNoticeText(agentSessionWriteNotDoneParts('send'))
      }
      // A consumed draft whose submission a Stop withdrew is not a failure of the
      // message — say what happened rather than "not sent".
      if (
        classifyDispatchRejection({ reason, rejection: card.returnedRejection }).category ===
        'withdrawn'
      ) {
        return translate(
          'components.native-chat.queuedMessages.withdrawnHold',
          'Stopped before it was sent'
        )
      }
      return agentSessionWriteNoticeText(
        structuredAgentSessionAttemptFailureParts(
          { kind: 'rejected', reason },
          // The card's own Send is the retry, so the words leave out sending again.
          { agentName, retryControl: true },
          readWholeAgentSessionFailureFact(card.returnedRejection)
        )
      )
    }
    case 'paused':
      // A card's own hold; the queue's pause is the list's header. Markers localize, and an absent
      // or unknown one (newer host) is a plain pause, never shown raw.
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

function queuedMessageImageCount(count: number): string {
  return translate('components.native-chat.queuedMessages.imageCount', '{{count}} images', {
    count
  })
}

/** The card's line: its text, or for a card of images alone, the image's name or their count. */
function queuedMessageCardLine(card: QueuedMessageCard): string {
  const images = card.images ?? []
  if (card.text.trim() || images.length === 0) {
    return card.text
  }
  return images.length === 1
    ? nativeChatImageLabel(images[0])
    : queuedMessageImageCount(images.length)
}

/** Steer's or Send's label and tooltip (`queuedMessageCardSteers`). */
export function queuedMessageCardSendNow(card: QueuedMessageCard): {
  /** Steer's ↳, or Send's paper plane. */
  steers: boolean
  label: string
  hint: string
} {
  if (!queuedMessageCardSteers(card)) {
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
  steerHeld = false,
  pending = null,
  onSteer,
  onDelete,
  onEdit,
  editor,
  editAttachTo,
  editDisabled = false,
  onTurnOffQueueing
}: {
  card: QueuedMessageCard
  /** The chat's worktree, whose host its sender is found on; null shows the sender unlinked. */
  chatWorktreeId: string | null
  agentName?: string
  statedFailures?: readonly AgentSessionFailureFact[]
  /** Only the newest card answers Cmd/Ctrl+Enter; only it may show the chord. */
  showsSteerShortcut: boolean
  /** The chat reads Stopping: the card waits for the stop (`NativeChatQueuedMessageList`). */
  steerHeld?: boolean
  /** Its own action, or a Clear all deleting it, still on its way to the host: the card greys,
   *  and the button that was pressed spins. */
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
  /** Absent when the host does not queue sends, so there is nothing to turn off. */
  onTurnOffQueueing?: () => void
}): React.JSX.Element {
  const caption = queuedMessageCardCaption(card, agentName, statedFailures)
  const line = queuedMessageCardLine(card)
  const returned = card.state === 'returned'
  const sendNow = queuedMessageCardSendNow(card)
  const busy = pending !== null
  const isMac = isMacPlatform()
  // A clipped line opens below the row, at the card's full width: a card can hold text the person
  // never typed (another agent's message), and Steer or Delete must not be a blind choice.
  const [expanded, setExpanded] = useState(false)
  const [clipped, measureLine] = useNativeChatClippedLine(false)
  const textId = useId()
  const sender = card.from ? (
    <NativeChatAgentMessageSenders from={card.from} chatWorktreeId={chatWorktreeId} queued />
  ) : null
  if (editor) {
    // The editor's own header stands in for the icon, the actions and the caption.
    return (
      // The editor fills the row, so a drop anywhere on the card reaches it.
      <li data-queued-message-id={card.messageId} data-queued-message-state={card.state}>
        <NativeChatQueuedMessageEditor
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
      data-queued-message-id={card.messageId}
      data-queued-message-state={card.state}
      className="px-2.5 py-1.5"
    >
      <div className="flex items-center gap-2">
        {returned || card.pausedReason === QUEUED_MESSAGE_PAUSED_SEND_FAILED ? (
          <AlertCircle className="size-3.5 shrink-0 text-destructive" aria-hidden />
        ) : (
          <ListEnd className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        )}
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
                      <ShortcutKeyCombo keys={[isMac ? '⌘' : 'Ctrl', isMac ? '⏎' : 'Enter']} />
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
            {(!card.command && onEdit) || onTurnOffQueueing ? (
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
                  {/* A command's text is not a draft: edited, it would become a message. */}
                  {card.command || !onEdit ? null : (
                    <DropdownMenuItem disabled={editDisabled} onSelect={onEdit}>
                      <Pencil />
                      {translate(
                        'components.native-chat.queuedMessages.editMessage',
                        'Edit message'
                      )}
                    </DropdownMenuItem>
                  )}
                  {onTurnOffQueueing ? (
                    <DropdownMenuItem onSelect={onTurnOffQueueing}>
                      {translate(
                        'components.native-chat.queuedMessages.turnOffQueueing',
                        'Turn off queueing'
                      )}
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </>
        )}
      </div>
      {expanded ? (
        // Indented to the text, past the icon slot and its gap.
        <p
          id={textId}
          className="scrollbar-sleek mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap break-words pl-5.5 text-sm"
        >
          {line}
        </p>
      ) : null}
    </li>
  )
}

/** Images are named in the tooltip, not drawn: the row stays one line. */
function QueuedMessageImageCount({
  images
}: {
  images: NonNullable<QueuedMessageCard['images']>
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          tabIndex={0}
          aria-label={queuedMessageImageCount(images.length)}
          className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ImageIcon className="size-3.5" aria-hidden />
          <span aria-hidden>{images.length}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {images.map(nativeChatImageLabel).join(', ')}
      </TooltipContent>
    </Tooltip>
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
