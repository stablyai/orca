import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { agentSessionWriteNoticeText } from '../messages/notices/agent-session-write-notice-text'
import type { AgentSessionFailureFact } from '../../../../../shared/agent-session/failures/agent-session-failure'
import { QUEUED_MESSAGE_PAUSED_SEND_FAILED } from '../../../../../shared/agent-session/requests/agent-session-queued-message-wire'
import {
  queuedMessageReturnedNotice,
  queuedMessageCardSteers,
  type QueuedMessageCard
} from '../../../../../shared/agent-session/view/structured-agent-session-queued-cards'

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
          : t('components.native-chat.queuedMessages.couldNotSend', "Couldn't send")
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
  card: Pick<QueuedMessageCard, 'hold' | 'command'>,
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
