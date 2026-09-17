import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

export type RestartActionOutcome = {
  sessionId: string
  outcome: 'resumed' | 'continued' | 'pending' | 'unknown' | 'refused'
}

function announceResumed(count: number): void {
  if (count <= 0) {
    return
  }
  toast(
    count === 1
      ? translate('auto.components.NativeChatResumeOnRestartModal.resumedOne', 'Reconnected 1 chat')
      : translate(
          'auto.components.NativeChatResumeOnRestartModal.resumedMany',
          'Reconnected {{value0}} chats',
          {
            value0: count
          }
        )
  )
}

function announceContinued(count: number): void {
  if (count <= 0) {
    return
  }
  toast(
    count === 1
      ? translate(
          'auto.components.NativeChatResumeOnRestartModal.continuedOne',
          'Reconnected 1 chat and asked it to continue'
        )
      : translate(
          'auto.components.NativeChatResumeOnRestartModal.continuedMany',
          'Reconnected {{value0}} chats and asked them to continue',
          { value0: count }
        )
  )
}

export function announceRestartUnconfirmed(count: number, action: 'reconnect' | 'continue'): void {
  if (count <= 0) {
    return
  }
  toast(
    action === 'continue'
      ? translate(
          'auto.components.NativeChatResumeOnRestartModal.continueUnconfirmed',
          'Continuation delivery is unconfirmed for {{value0}} chats. Open them to check before sending another message.',
          { value0: count, count }
        )
      : translate(
          'auto.components.NativeChatResumeOnRestartModal.reconnectUnconfirmed',
          'Reconnection is unconfirmed for {{value0}} chats. You can still open them normally.',
          { value0: count, count }
        )
  )
}

export function announceRestartResults(
  requested: readonly string[],
  results: readonly RestartActionOutcome[],
  action: 'reconnect' | 'continue'
): void {
  const bySession = new Map(results.map((result) => [result.sessionId, result.outcome]))
  let succeeded = 0
  let unconfirmed = 0
  let refused = 0
  for (const sessionId of new Set(requested)) {
    const outcome = bySession.get(sessionId)
    if (outcome === (action === 'continue' ? 'continued' : 'resumed')) {
      succeeded += 1
    } else if (outcome === 'pending' || outcome === 'unknown') {
      unconfirmed += 1
    } else {
      // Eligibility can change after listing, so an omitted row was not acted on either.
      refused += 1
    }
  }
  if (action === 'continue') {
    announceContinued(succeeded)
  } else {
    announceResumed(succeeded)
  }
  if (refused > 0) {
    toast(
      action === 'continue'
        ? translate(
            'auto.components.NativeChatResumeOnRestartModal.continueRefused',
            '{{value0}} chats could not be continued. Open them to continue manually.',
            { value0: refused, count: refused }
          )
        : translate(
            'auto.components.NativeChatResumeOnRestartModal.reconnectRefused',
            '{{value0}} chats could not be reconnected. You can still open them normally.',
            { value0: refused, count: refused }
          )
    )
  }
  announceRestartUnconfirmed(unconfirmed, action)
}
