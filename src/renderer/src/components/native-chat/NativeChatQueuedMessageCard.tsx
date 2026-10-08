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
import { queuedCardSenderLine } from './native-chat-agent-message-sender-label'
import { agentSessionFailureStatedByStartRow } from './structured-agent-session-delivery-notices'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import { agentSessionWriteNotDoneParts } from '../../../../shared/agent-session-refusal-notice'

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
    case 'awaiting-answer':
      return translate(
        'components.native-chat.queuedMessages.awaitingAnswerHold',
        'Waiting for your answer'
      )
    case 'sending':
      return translate('components.native-chat.messageSending', 'Sending…')
    case 'turn':
    case 'queue-paused':
      // Plainly queued; a paused queue's header row carries the why.
      return null
  }
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
  agentName,
  statedFailures,
  showsSteerShortcut,
  steerHeld = false,
  onSteer,
  onDelete,
  onEdit,
  onTurnOffQueueing
}: {
  card: QueuedMessageCard
  agentName?: string
  statedFailures?: readonly AgentSessionFailureFact[]
  /** Only the newest card answers Cmd/Ctrl+Enter; only it may show the chord. */
  showsSteerShortcut: boolean
  /** The chat reads Stopping: the card waits for the stop (`NativeChatQueuedMessageList`). */
  steerHeld?: boolean
  onSteer: () => void
  onDelete: () => void
  onEdit: () => void
  /** Absent when the host does not queue sends, so there is nothing to turn off. */
  onTurnOffQueueing?: () => void
}): React.JSX.Element {
  const caption = queuedMessageCardCaption(card, agentName, statedFailures)
  const returned = card.state === 'returned'
  const sendNow = queuedMessageCardSendNow(card)
  const isMac = isMacPlatform()
  return (
    <li
      data-queued-message-id={card.messageId}
      data-queued-message-state={card.state}
      className="flex items-center gap-2 px-2.5 py-1.5"
    >
      {returned || card.pausedReason === QUEUED_MESSAGE_PAUSED_SEND_FAILED ? (
        <AlertCircle className="size-3.5 shrink-0 text-destructive" aria-hidden />
      ) : (
        <ListEnd className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        {card.from ? (
          <p className="truncate text-xs text-muted-foreground">
            {queuedCardSenderLine(card.from)}
          </p>
        ) : null}
        <p className="truncate text-sm" title={card.text}>
          {card.text}
        </p>
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
                  disabled={steerHeld}
                >
                  {sendNow.steers ? (
                    <CornerDownRight className="size-3" />
                  ) : (
                    <Send className="size-3" />
                  )}
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
                onClick={onDelete}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {translate('components.native-chat.queuedMessages.delete', 'Delete')}
            </TooltipContent>
          </Tooltip>
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
              >
                <MoreHorizontal className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {/* A command's text is not a draft: edited, it would become a message. */}
              {card.command ? null : (
                <DropdownMenuItem onSelect={onEdit}>
                  <Pencil />
                  {translate('components.native-chat.queuedMessages.editMessage', 'Edit message')}
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
        </>
      )}
    </li>
  )
}
