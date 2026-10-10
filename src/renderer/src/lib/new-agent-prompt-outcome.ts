import type { ActiveAgentNotesSendResult } from './active-agent-note-send-result'
import type { StructuredPromptDeliveryResult } from './structured-agent-session-launch-prompt'

/** `delivered`: the notes' text reached the new chat, sent or waiting in its composer, so the notes
 *  let go of it. `failure`: why it did not, for the one report the notes' sender makes; absent
 *  when the chat already shows it (a start that failed, a cancelled launch). */
export type NewAgentPromptOutcome = { delivered: boolean; failure?: ActiveAgentNotesSendResult }

function notesFailure(
  result: Pick<StructuredPromptDeliveryResult, 'unconfirmed' | 'busy'>
): ActiveAgentNotesSendResult {
  if (result.unconfirmed) {
    return { status: 'unconfirmed', code: 'runtime-unverifiable' }
  }
  return result.busy
    ? { status: 'not-ready', code: 'session-send-refused' }
    : { status: 'not-writable', code: 'session-send-refused' }
}

/** Settles once a new agent's prompt reached its host or its composer, or did not: a start that
 *  failed shows its own failure in the new chat. */
export function newAgentPromptOutcome(args: {
  delivery: Promise<
    Pick<StructuredPromptDeliveryResult, 'delivered'> & Partial<StructuredPromptDeliveryResult>
  >
}): Promise<NewAgentPromptOutcome> {
  return args.delivery.then(
    (result) =>
      result.delivered || result.inComposer
        ? { delivered: true }
        : result.failureNotified
          ? { delivered: false }
          : { delivered: false, failure: notesFailure(result) },
    () => ({ delivered: false })
  )
}
