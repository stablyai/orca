import type { ActiveAgentNotesSendResult } from './active-agent-note-send-result'
import type { StructuredPromptDeliveryResult } from './structured-agent-session-launch-prompt'

/** Delivered releases notes once host/composer owns the text; failure is omitted when the chat already reports startup/cancellation. */
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
