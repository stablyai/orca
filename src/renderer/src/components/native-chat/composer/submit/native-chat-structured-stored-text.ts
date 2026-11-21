import { structuredAgentSessionStoredText } from '../../../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import type { captureNativeChatStagedInput } from '../../drafts/native-chat-draft-attachment-staging'
import type { StructuredAgentSessionAttachmentPreparation } from '../../session/structured/delivery/structured-agent-session-send-slot'
import type { NativeChatComposerImageAttachment } from '../../attachments/chips/native-chat-image-attachment'
import type { NativeChatStructuredComposerTransport } from './native-chat-structured-composer-transport'
import { nativeChatStructuredStoredPrompt } from './native-chat-structured-composer-dispatch'

/** The words a structured send's message stores, for recording which message its reply answers.
 *  Staging (a remote host) rewrites file paths while preparing the message, so then the stored
 *  words are the prepared text; otherwise they're the prompt as dispatched. */
export function trackNativeChatStructuredStoredText(
  stagedInput: ReturnType<typeof captureNativeChatStagedInput> | undefined,
  transport: NativeChatStructuredComposerTransport
): {
  prepareAttachments: StructuredAgentSessionAttachmentPreparation | undefined
  storedText: (
    draftText: string,
    attachments: readonly NativeChatComposerImageAttachment[]
  ) => Promise<string>
} {
  let prepared: Promise<string> | undefined
  return {
    prepareAttachments: stagedInput
      ? (input) => {
          const preparing = stagedInput.prepare(input, transport)
          prepared = preparing.then((output) => structuredAgentSessionStoredText(output.text))
          return preparing
        }
      : undefined,
    storedText: (draftText, attachments) =>
      prepared ?? Promise.resolve(nativeChatStructuredStoredPrompt(draftText, attachments))
  }
}
