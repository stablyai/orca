import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

/**
 * What Orca tells the user after acting on a restart offer.
 *
 * Resuming sends a message, so every string here has to say one went out — and an opted-in launch
 * has no dialog in front of it, which makes these toasts the only place that user learns it did.
 */

/** One `continued` row as the host reports it. */
export type RestartContinuationOutcome = {
  sessionId: string
  outcome: 'continued' | 'pending' | 'unknown' | 'refused'
}

function announceContinued(count: number): void {
  if (count <= 0) {
    return
  }
  toast(
    count === 1
      ? translate(
          'auto.components.NativeChatResumeOnRestartModal.continuedOne',
          'Resumed 1 chat and asked it to continue'
        )
      : translate(
          'auto.components.NativeChatResumeOnRestartModal.continuedMany',
          'Resumed {{value0}} chats and asked them to continue',
          { value0: count }
        )
  )
}

/** Delivery the host never confirmed. Reported, never retried — a second send is the user's call. */
export function announceRestartUnconfirmed(count: number): void {
  if (count <= 0) {
    return
  }
  toast(
    translate(
      'auto.components.NativeChatResumeOnRestartModal.continueUnconfirmed',
      'Continuation delivery is unconfirmed for {{value0}} chats. Open them to check before sending another message.',
      { value0: count, count }
    )
  )
}

/** A dismissal Orca could not confirm. The offer belongs to the host, so say it may still be there. */
export function announceRestartDismissUnconfirmed(): void {
  toast(
    translate(
      'auto.components.NativeChatResumeOnRestartModal.dismissUnconfirmed',
      'Dismissing the resume offer was not confirmed — it may still be in the status bar.'
    )
  )
}

export function announceRestartResults(
  requested: readonly string[],
  results: readonly RestartContinuationOutcome[]
): void {
  const bySession = new Map(results.map((result) => [result.sessionId, result.outcome]))
  let succeeded = 0
  let unconfirmed = 0
  let refused = 0
  for (const sessionId of new Set(requested)) {
    const outcome = bySession.get(sessionId)
    if (outcome === 'continued') {
      succeeded += 1
    } else if (outcome === 'pending' || outcome === 'unknown') {
      unconfirmed += 1
    } else {
      // Eligibility can change after listing, so an omitted row was not acted on either.
      refused += 1
    }
  }
  announceContinued(succeeded)
  if (refused > 0) {
    toast(
      translate(
        'auto.components.NativeChatResumeOnRestartModal.continueRefused',
        '{{value0}} chats could not be continued. Open them to continue manually.',
        { value0: refused, count: refused }
      )
    )
  }
  announceRestartUnconfirmed(unconfirmed)
}
