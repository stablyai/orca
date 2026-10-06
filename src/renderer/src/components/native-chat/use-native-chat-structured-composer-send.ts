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
import { pushHistory, type HistoryState } from './native-chat-composer-state'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import { nativeChatAttachImagesAgainReason } from './native-chat-image-reattach'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { nativeChatComposerDraftLeftAfterSend } from './native-chat-composer-draft-comparison'

export type UseNativeChatStructuredComposerSendArgs = {
  agent: AgentType
  draftScopeKey: string
  imageAttachments: readonly NativeChatComposerImageAttachment[]
  structuredTransport?: NativeChatStructuredComposerTransport
  isComposing: () => boolean
  clearSkillOrigin: () => void
  setHistory: (updater: (previous: HistoryState) => HistoryState) => void
  setDraft: (value: string) => void
  setCaret: (caret: number) => void
}

/** Send through the structured journal transport, clearing the composer only
 *  once the transport accepts (the PTY path has its own sibling hook). */
export function useNativeChatStructuredComposerSend({
  agent,
  draftScopeKey,
  imageAttachments,
  structuredTransport,
  isComposing,
  clearSkillOrigin,
  setHistory,
  setDraft,
  setCaret
}: UseNativeChatStructuredComposerSendArgs): (
  text: string,
  attachments?: readonly NativeChatComposerImageAttachment[]
) => void {
  return useCallback(
    (text: string, attachments = imageAttachments): void => {
      if (!structuredTransport) {
        return
      }
      const hostCommand =
        isStructuredAgentSessionComposerCommand(text, agent) ||
        (structuredTransport.threadGoal !== undefined && isStructuredAgentSessionGoalCommand(text))
      // A command picked while images await re-attaching would send them without a file.
      const attachAgain = nativeChatAttachImagesAgainReason(attachments)
      if (attachAgain) {
        structuredTransport.onError(attachAgain)
        return
      }
      if (attachments.length > 0 && hostCommand) {
        structuredTransport.onError('Remove attachments before using a chat-session command.')
        return
      }
      // A conversation command reveals at the press, not after its round trip; options move nothing.
      if (hostCommand && structuredAgentSessionCommandChangesConversation(text)) {
        structuredTransport.onSubmitted?.()
      }
      const submitted = readNativeChatComposerDraft(draftScopeKey)
      void dispatchNativeChatStructuredComposerText(structuredTransport, text, attachments)
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
          setHistory((previous) => pushHistory(previous, text))
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
        .catch((error) =>
          structuredTransport.onError(error instanceof Error ? error.message : String(error))
        )
    },
    [
      agent,
      clearSkillOrigin,
      draftScopeKey,
      imageAttachments,
      isComposing,
      setCaret,
      setDraft,
      setHistory,
      structuredTransport
    ]
  )
}
