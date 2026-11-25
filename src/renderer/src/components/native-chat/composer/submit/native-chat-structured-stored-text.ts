import { structuredAgentSessionStoredText } from '../../../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import type { captureNativeChatStagedInput } from '../../drafts/native-chat-draft-attachment-staging'
import type { StructuredAgentSessionAttachmentPreparation } from '../../session/structured/delivery/structured-agent-session-send-slot'
import type { NativeChatComposerImageAttachment } from '../../attachments/chips/native-chat-image-attachment'
import type { NativeChatStructuredComposerTransport } from './native-chat-structured-composer-transport'
import { nativeChatStructuredStoredPrompt } from './native-chat-structured-composer-dispatch'

/** The words a structured send's message stores, for recording which message its reply answers.
 *  The reservation holds the prompt as dispatched until staging (a remote host) finishes rewriting
 *  file paths, so a send stopped or refused meanwhile comes back with those words; once prepared,
 *  the message stores the prepared text instead. */
export function trackNativeChatStructuredStoredText(
  stagedInput: ReturnType<typeof captureNativeChatStagedInput> | undefined,
  transport: NativeChatStructuredComposerTransport
): {
  prepareAttachments: StructuredAgentSessionAttachmentPreparation | undefined
  /** The words the reservation holds from admission. */
  admittedText: (
    draftText: string,
    attachments: readonly NativeChatComposerImageAttachment[]
  ) => string
  /** The prepared words, only once the reservation took them; null when it was stopped, dropped
   *  or failed first, so its message never stores them. */
  preparedText: () => Promise<string | null> | undefined
} {
  let prepared: Promise<string | null> | undefined
  return {
    prepareAttachments: stagedInput
      ? (input, isCurrent) => {
          const preparing = stagedInput.prepare(input, transport)
          // Checked as the upload settles, just before the sender installs this body under the
          // same check: a reservation stopped or dropped meanwhile never sends it.
          prepared = preparing.then(
            (output) => (isCurrent() ? structuredAgentSessionStoredText(output.text) : null),
            () => null
          )
          return preparing
        }
      : undefined,
    admittedText: nativeChatStructuredStoredPrompt,
    preparedText: () => prepared
  }
}
