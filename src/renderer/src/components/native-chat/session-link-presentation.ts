import type { SessionLinkEvent, SessionLinkSnapshot } from '../../../../shared/session-link'
import { sessionLinkWaitingFor } from '../../../../shared/session-link-wait'
import { translate as t } from '@/i18n/i18n'

export function sessionLinkReason(reason: string): string {
  const labels: Record<string, string> = {
    pause: t('components.sessionLink.reasonPause', 'Paused by the owner'),
    stop: t('components.sessionLink.reasonStop', 'Urgent stop requested'),
    end: t('components.sessionLink.reasonEnd', 'Link ended'),
    'turn-limit': t('components.sessionLink.reasonTurns', 'Automatic turn limit reached'),
    'message-limit': t('components.sessionLink.reasonMessages', 'Agent message limit reached'),
    'repeated-messages': t(
      'components.sessionLink.reasonRepeated',
      'Repeated messages; owner review needed'
    ),
    'owner-decision': t(
      'components.sessionLink.reasonOwner',
      'Owner decision needed. Write your answer, then continue.'
    ),
    'participant-changed': t(
      'components.sessionLink.reasonParticipant',
      'A chat closed or changed context. Verify both chats before continuing.'
    ),
    'delivery-held': t(
      'components.sessionLink.reasonHeld',
      'Delivery held before dispatch. Review and continue to retry.'
    ),
    'delivery-refused': t(
      'components.sessionLink.reasonRefused',
      'The session refused delivery. Review the chat before retrying.'
    ),
    'delivery-unknown': t(
      'components.sessionLink.reasonUnknown',
      'Delivery is unconfirmed. Check the chat; this message will not be sent again.'
    ),
    'stop-pending': t('components.sessionLink.stopPending', 'Stop requested'),
    'stop-acknowledged': t('components.sessionLink.stopAcknowledged', 'Link turn stopped'),
    'stop-unrelated-turn': t(
      'components.sessionLink.stopUnrelated',
      'The current turn was started outside this link and was left running.'
    ),
    'stop-unconfirmed': t(
      'components.sessionLink.stopUnconfirmed',
      'Stop unconfirmed. Use Stop in the agent chat.'
    )
  }
  return labels[reason] ?? reason
}

export function sessionLinkEventKind(kind: SessionLinkEvent['kind']): string {
  return {
    control: t('components.sessionLink.control', 'Link control'),
    introduction: t('components.sessionLink.introduction', 'Introduction'),
    message: t('components.sessionLink.message', 'Message'),
    question: t('components.sessionLink.question', 'Question'),
    checkpoint: t('components.sessionLink.checkpoint', 'Checkpoint'),
    reply: t('components.sessionLink.reply', 'Reply'),
    'owner-request': t('components.sessionLink.ownerRequest', 'Owner decision'),
    'owner-note': t('components.sessionLink.ownerNote', 'Owner message')
  }[kind]
}

export function sessionLinkDeliveryState(state: SessionLinkEvent['state']): string {
  return {
    recorded: t('components.sessionLink.recorded', 'Recorded'),
    queued: t('components.sessionLink.queued', 'Queued'),
    dispatching: t('components.sessionLink.dispatching', 'Sending'),
    accepted: t('components.sessionLink.accepted', 'Delivered'),
    blocked: t('components.sessionLink.blocked', 'Needs review'),
    cancelled: t('components.sessionLink.cancelled', 'Cancelled')
  }[state]
}

export function sessionLinkStatus(snapshot: SessionLinkSnapshot): string {
  if (snapshot.link.state === 'ended') {
    return t('components.sessionLink.ended', 'Link ended. The journal is retained.')
  }
  if (snapshot.link.state === 'paused') {
    return `${t('components.sessionLink.paused', 'Paused')} · ${sessionLinkReason(snapshot.link.reason)}`
  }
  const waiting = snapshot.link.participants
    .filter((p) => sessionLinkWaitingFor(snapshot.events, p.sessionId))
    .map((p) => p.name)
  if (waiting.length) {
    return `${t('components.sessionLink.waiting', 'Waiting for a reply')}: ${waiting.join(', ')}`
  }
  return t(
    'components.sessionLink.active',
    'Link active. Busy agents receive messages after their current turn.'
  )
}
