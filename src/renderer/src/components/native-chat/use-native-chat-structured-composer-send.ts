import { useCallback } from 'react'
import { emitNativeChatMessageSent } from '@/lib/native-chat-telemetry'
import { isStructuredAgentSessionComposerCommand } from '../../../../shared/structured-agent-session-composer'
import type { AgentType } from '../../../../shared/agent-status-types'
import { dispatchNativeChatStructuredComposerText } from './native-chat-structured-composer-dispatch'
import { pushHistory, type HistoryState } from './native-chat-composer-state'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'

export type UseNativeChatStructuredComposerSendArgs = {
  agent: AgentType
  imageAttachments: readonly NativeChatComposerImageAttachment[]
  structuredTransport?: NativeChatStructuredComposerTransport
  clearImageAttachments: () => void
  clearSkillOrigin: () => void
  setHistory: (updater: (previous: HistoryState) => HistoryState) => void
  setDraft: (value: string) => void
  setCaret: (caret: number) => void
}

/** Send through the structured journal transport, clearing the composer only
 *  once the transport accepts (the PTY path has its own sibling hook). */
export function useNativeChatStructuredComposerSend({
  agent,
  imageAttachments,
  structuredTransport,
  clearImageAttachments,
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
      if (attachments.length > 0 && isStructuredAgentSessionComposerCommand(text, agent)) {
        structuredTransport.onError('Remove attachments before using a chat-session command.')
        return
      }
      void dispatchNativeChatStructuredComposerText(structuredTransport, text, attachments)
        .then(({ accepted, error }) => {
          structuredTransport.onError(error)
          if (!accepted) {
            return
          }
          emitNativeChatMessageSent({ agent, runtime: structuredTransport.runtime })
          setHistory((previous) => pushHistory(previous, text))
          setDraft('')
          setCaret(0)
          clearSkillOrigin()
          clearImageAttachments()
        })
        .catch((error) =>
          structuredTransport.onError(error instanceof Error ? error.message : String(error))
        )
    },
    [
      agent,
      clearImageAttachments,
      clearSkillOrigin,
      imageAttachments,
      setCaret,
      setDraft,
      setHistory,
      structuredTransport
    ]
  )
}
