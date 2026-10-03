import { useCallback, useEffect, useRef } from 'react'
import { emitNativeChatMessageSent } from '@/lib/native-chat-telemetry'
import { reportStructuredSessionUserInput } from '@/lib/worker-terminal-takeover-report'
import {
  isStructuredAgentSessionComposerCommand,
  isStructuredAgentSessionGoalCommand
} from '../../../../shared/structured-agent-session-composer'
import type { AgentType } from '../../../../shared/agent-status-types'
import { dispatchNativeChatStructuredComposerText } from './native-chat-structured-composer-dispatch'
import { pushHistory, type HistoryState } from './native-chat-composer-state'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import {
  clearNativeChatComposerDraftIfUnchanged,
  readNativeChatComposerDraft
} from './native-chat-composer-draft-store'

export type UseNativeChatStructuredComposerSendArgs = {
  agent: AgentType
  draftScopeKey: string
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
  draftScopeKey,
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
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  return useCallback(
    (text: string, attachments = imageAttachments): void => {
      if (!structuredTransport) {
        return
      }
      const hostCommand =
        isStructuredAgentSessionComposerCommand(text, agent) ||
        (structuredTransport.threadGoal !== undefined && isStructuredAgentSessionGoalCommand(text))
      if (attachments.length > 0 && hostCommand) {
        structuredTransport.onError('Remove attachments before using a chat-session command.')
        return
      }
      const submitted = readNativeChatComposerDraft(draftScopeKey)
      void dispatchNativeChatStructuredComposerText(structuredTransport, text, attachments)
        .then(({ accepted, error }) => {
          structuredTransport.onError(error)
          if (!accepted) {
            return
          }
          emitNativeChatMessageSent({ agent, runtime: structuredTransport.runtime })
          // A real user send is a takeover, exactly as typing into a worker's pane is. Only past
          // `accepted`, and only from this hook: the outbox dispatcher retries and would re-fire,
          // and orchestration's own pointer nudges never reach the composer at all.
          reportStructuredSessionUserInput(
            structuredTransport.sessionId,
            structuredTransport.runtimeEnvironmentId
          )
          setHistory((previous) => pushHistory(previous, text))
          // Why: a host command settles after a round trip, and a replaced composer's send after
          // the user may have typed in the new one; either clears only a draft still as sent, and
          // leaves an image pasted meanwhile, which was never part of it.
          if (hostCommand || !mounted.current) {
            if (clearNativeChatComposerDraftIfUnchanged(draftScopeKey, submitted)) {
              setCaret(0)
              clearSkillOrigin()
            }
            return
          }
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
      draftScopeKey,
      imageAttachments,
      setCaret,
      setDraft,
      setHistory,
      structuredTransport
    ]
  )
}
