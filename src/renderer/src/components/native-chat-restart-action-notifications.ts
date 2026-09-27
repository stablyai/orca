import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { ResumeFailure } from './native-chat-resume-on-restart-grouping'

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

/** What the failure toast can do: open the modal that lists the chats, or forget them. Passed in
 *  because the offer store owns both and this module must not import it back. */
export type RestartFailureActions = {
  show: () => void
  dismiss: (sessionIds: readonly string[]) => void
}

function refusedCountText(count: number): string {
  return count === 1
    ? translate(
        'auto.components.NativeChatResumeOnRestartModal.notContinuedOne',
        '1 chat couldn’t be resumed'
      )
    : translate(
        'auto.components.NativeChatResumeOnRestartModal.notContinuedMany',
        '{{value0}} chats couldn’t be resumed',
        { value0: count }
      )
}

function unconfirmedCountText(count: number): string {
  return count === 1
    ? translate(
        'auto.components.NativeChatResumeOnRestartModal.notConfirmedOne',
        'Couldn’t confirm 1 chat was resumed'
      )
    : translate(
        'auto.components.NativeChatResumeOnRestartModal.notConfirmedMany',
        'Couldn’t confirm {{value0}} chats were resumed',
        { value0: count }
      )
}

/** Beneath a refused count, so it cannot read as the same chat restated. */
function otherUnconfirmedCountText(count: number): string {
  return count === 1
    ? translate(
        'auto.components.NativeChatResumeOnRestartModal.notConfirmedOtherOne',
        'Couldn’t confirm 1 other chat was resumed'
      )
    : translate(
        'auto.components.NativeChatResumeOnRestartModal.notConfirmedOtherMany',
        'Couldn’t confirm {{value0}} other chats were resumed',
        { value0: count }
      )
}

/** The chats an action did not carry on. No names here: the modal has the list, and the count is
 *  the same shape whether it is one chat or ten. Unconfirmed chats get their own count because the
 *  agent may well be working; "couldn't be resumed" would invite a duplicate send. Dismiss forgets
 *  only the chats the host listed as failed — a chat that merely dropped out of the answer may
 *  still be a live offer. */
function announceNotContinued(
  refused: readonly string[],
  unconfirmed: readonly string[],
  hostFailed: ReadonlySet<string>,
  actions: RestartFailureActions
): void {
  const counted = [...refused, ...unconfirmed]
  if (counted.length === 0) {
    return
  }
  const dismissable = counted.filter((sessionId) => hostFailed.has(sessionId))
  const title =
    refused.length > 0 ? refusedCountText(refused.length) : unconfirmedCountText(unconfirmed.length)
  toast(title, {
    ...(refused.length > 0 && unconfirmed.length > 0
      ? { description: otherUnconfirmedCountText(unconfirmed.length) }
      : {}),
    action: {
      label: translate('auto.components.NativeChatResumeOnRestartModal.show', 'Show'),
      onClick: actions.show
    },
    ...(dismissable.length === 0
      ? {}
      : {
          cancel: {
            label: translate('auto.components.NativeChatResumeOnRestartModal.dismiss', 'Dismiss'),
            onClick: () => actions.dismiss(dismissable)
          }
        })
  })
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

/** Which of the requested chats the host did not carry on: refused, unconfirmed, or — since
 *  eligibility can change after listing — omitted from the answer altogether. */
export function restartChatsNotContinued(
  requested: readonly string[],
  results: readonly RestartContinuationOutcome[]
): string[] {
  const bySession = new Map(results.map((result) => [result.sessionId, result.outcome]))
  return [...new Set(requested)].filter((sessionId) => bySession.get(sessionId) !== 'continued')
}

export function announceRestartResults(
  requested: readonly string[],
  results: readonly RestartContinuationOutcome[],
  /** The host's own failure list after the action; undefined from an older host. */
  hostFailed: readonly Pick<ResumeFailure, 'sessionId' | 'outcome'>[] | undefined,
  actions: RestartFailureActions
): void {
  const notContinued = restartChatsNotContinued(requested, results)
  const failed = new Map(hostFailed?.map((failure) => [failure.sessionId, failure.outcome]))
  // A host that lists failures has already dropped chats that moved on by themselves or that the
  // user answered; counting those would report a failure nothing on screen can show.
  const reported =
    hostFailed === undefined
      ? notContinued
      : notContinued.filter((sessionId) => failed.has(sessionId))
  const outcomes = new Map(results.map((result) => [result.sessionId, result.outcome]))
  const sentUnconfirmed = (sessionId: string): boolean =>
    outcomes.get(sessionId) === 'pending' || outcomes.get(sessionId) === 'unknown'
  // An unconfirmed send the host no longer lists was seen carrying on (or answered by the user), so
  // it was resumed and asked to continue; left out of both counts, the action would say nothing.
  const seenCarryingOn = notContinued.filter(
    (sessionId) => !reported.includes(sessionId) && sentUnconfirmed(sessionId)
  )
  // The host's filed outcome is what the list shows, so the toast uses it too.
  const unconfirmed = (sessionId: string): boolean =>
    (failed.get(sessionId) ?? (sentUnconfirmed(sessionId) ? 'unconfirmed' : 'refused')) ===
    'unconfirmed'
  announceContinued(new Set(requested).size - notContinued.length + seenCarryingOn.length)
  announceNotContinued(
    reported.filter((sessionId) => !unconfirmed(sessionId)),
    reported.filter(unconfirmed),
    new Set(failed.keys()),
    actions
  )
}
