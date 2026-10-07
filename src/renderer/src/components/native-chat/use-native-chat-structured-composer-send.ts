import { useCallback } from 'react'
import { emitNativeChatMessageSent } from '@/lib/native-chat-telemetry'
import { reportStructuredSessionUserInput } from '@/lib/worker-terminal-takeover-report'
import {
  isStructuredAgentSessionComposerCommand,
  isStructuredAgentSessionGoalCommand,
  structuredAgentSessionCommandChangesConversation
} from '../../../../shared/structured-agent-session-composer'
import type { AgentType } from '../../../../shared/agent-status-types'
import { dispatchNativeChatStructuredComposerText } from './native-chat-structured-composer-dispatch'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import { nativeChatAttachImagesAgainReason } from './native-chat-image-reattach'
import { nativeChatNoticeFromError } from './native-chat-composer-notice'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'
import { translate } from '@/i18n/i18n'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { nativeChatComposerDraftLeftAfterSend } from './native-chat-composer-draft-comparison'
import type { NativeChatComposerDraft } from './native-chat-composer-draft-storage'

export type UseNativeChatStructuredComposerSendArgs = {
  agent: AgentType
  draftScopeKey: string
  imageAttachments: readonly NativeChatComposerImageAttachment[]
  structuredTransport?: NativeChatStructuredComposerTransport
  isComposing: () => boolean
  clearSkillOrigin: () => void
  setDraft: (value: string) => void
  setCaret: (caret: number) => void
}

/** A command the host runs itself (and `/goal` where the host sets goals), never a message. */
export function isNativeChatStructuredHostCommand(
  text: string,
  agent: AgentType,
  transport: NativeChatStructuredComposerTransport
): boolean {
  return (
    isStructuredAgentSessionComposerCommand(text, agent) ||
    (transport.threadGoal !== undefined && isStructuredAgentSessionGoalCommand(text))
  )
}

/** A structured send. `sentFrom`: the draft the message was taken from, for a send that goes out
 *  later than it was asked for; only what it held then leaves the composer. */
export type NativeChatStructuredComposerSend = (
  text: string,
  attachments?: readonly NativeChatComposerImageAttachment[],
  sentFrom?: NativeChatComposerDraft
) => Promise<void>

/** Send through the structured journal transport, clearing the composer only
 *  once the transport accepts (the PTY path has its own sibling hook). */
export function useNativeChatStructuredComposerSend({
  agent,
  draftScopeKey,
  imageAttachments,
  structuredTransport,
  isComposing,
  clearSkillOrigin,
  setDraft,
  setCaret
}: UseNativeChatStructuredComposerSendArgs): NativeChatStructuredComposerSend {
  return useCallback<NativeChatStructuredComposerSend>(
    async (text, attachments = imageAttachments, sentFrom): Promise<void> => {
      // A picked command is held like Send: it would carry attachments still uploading, pathless.
      if (!structuredTransport || attachments.some((attachment) => attachment.pending)) {
        return
      }
      const hostCommand = isNativeChatStructuredHostCommand(text, agent, structuredTransport)
      // A command picked while images await re-attaching would send them without a file.
      const attachAgain = nativeChatAttachImagesAgainReason(attachments)
      if (attachAgain) {
        structuredTransport.onError(attachAgain)
        return
      }
      if (attachments.length > 0 && hostCommand) {
        structuredTransport.onError(
          translate(
            'components.native-chat.composer.commandAttachmentsUnsupported',
            'Remove attachments before using a chat-session command.'
          )
        )
        return
      }
      // A conversation command reveals at the press, not after its round trip; options move nothing.
      if (hostCommand && structuredAgentSessionCommandChangesConversation(text)) {
        structuredTransport.onSubmitted?.()
      }
      const submitted = sentFrom ?? readNativeChatComposerDraft(draftScopeKey)
      await dispatchNativeChatStructuredComposerText(structuredTransport, text, attachments)
        .then(({ accepted, error, revealsTranscript }) => {
          structuredTransport.onError(error)
          if (!accepted) {
            return
          }
          emitNativeChatMessageSent({ agent, runtime: structuredTransport.runtime })
          if (revealsTranscript) {
            structuredTransport.onSubmitted?.()
          }
          // A real user send is a takeover, exactly as typing into a worker's pane is. Only past
          // `accepted`, and only from this hook: the outbox dispatcher retries and would re-fire,
          // and orchestration's own pointer nudges never reach the composer at all.
          reportStructuredSessionUserInput(
            structuredTransport.sessionId,
            structuredTransport.runtimeEnvironmentId
          )
          // Why: the send settles after a round trip, while this or another composer of the same
          // conversation may have changed the draft; only what was sent leaves it.
          const left = nativeChatComposerDraftLeftAfterSend(
            readNativeChatComposerDraft(draftScopeKey),
            submitted
          )
          if (!left) {
            return
          }
          updateNativeChatComposerDraft(draftScopeKey, { images: left.images }, 'immediate')
          // A live composition owns the field, which keeps only what it composed once cleared.
          const composing = isComposing()
          setDraft(composing ? '' : left.text)
          setCaret(composing ? 0 : left.text.length)
          clearSkillOrigin()
        })
        .catch((error) => {
          const notice = nativeChatNoticeFromError(
            error,
            agentSessionWriteNoticeText([hostCommand ? 'notDoneCommand' : 'notDoneSend'])
          )
          structuredTransport.onError(notice.text, notice.errorText)
        })
    },
    [
      agent,
      clearSkillOrigin,
      draftScopeKey,
      imageAttachments,
      isComposing,
      setCaret,
      setDraft,
      structuredTransport
    ]
  )
}
