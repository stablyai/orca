import { useCallback, useLayoutEffect, useRef } from 'react'
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
  clearNativeChatDraftForHeldSend,
  restoreNativeChatDraftIfEmpty,
  saveNativeChatDraftNow
} from './native-chat-draft-cache'
import {
  holdNativeChatDraftSend,
  releaseNativeChatHeldSend,
  renameNativeChatHeldSend
} from './native-chat-held-sends'
import { nativeChatDraftAttachmentsOf } from './native-chat-draft-save-after-send'
import { getStructuredAgentSessionOutbox } from './structured-agent-session-outbox-storage'
import { whenStructuredAgentSessionHostHasMessages } from './structured-agent-session-message-delivery'

export type UseNativeChatStructuredComposerSendArgs = {
  agent: AgentType
  /** The chat's draft (`nativeChatDraftKey`), where a refused message is put back. */
  draftKey: string
  draft?: string
  imageAttachments: readonly NativeChatComposerImageAttachment[]
  structuredTransport?: NativeChatStructuredComposerTransport
  clearImageAttachments: () => void
  clearSkillOrigin: () => void
  setHistory: (updater: (previous: HistoryState) => HistoryState) => void
  setDraft: (value: string) => void
  setCaret: (caret: number) => void
}

/** Send through the structured journal transport (the PTY path has its own sibling hook). A
 *  message clears the composer before the transport takes it and is put back if refused; a host
 *  command clears it only once accepted. */
export function useNativeChatStructuredComposerSend({
  agent,
  draftKey,
  draft,
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
  const composition = useRef({ draft, imageAttachments })
  useLayoutEffect(() => {
    composition.current = { draft, imageAttachments }
  }, [draft, imageAttachments])
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
      const submitted = composition.current
      const clearComposer = (): void => {
        setDraft('')
        setCaret(0)
        clearSkillOrigin()
        clearImageAttachments()
      }
      let cleared = false
      let outboxBefore: ReadonlySet<string> = new Set()
      const sent = { text, attachments: nativeChatDraftAttachmentsOf(attachments) }
      // A refused message goes back, unless something was typed since. The clear was never saved,
      // so saving the draft afterwards keeps what the box shows.
      const putBack = (): void => {
        if (cleared) {
          void restoreNativeChatDraftIfEmpty(draftKey, sent)
          void saveNativeChatDraftNow(draftKey)
        }
      }
      void dispatchNativeChatStructuredComposerText(structuredTransport, text, attachments, () => {
        // The box empties now, and is saved once the send has its id, together with the message as
        // a held send kept until the host has it: a crash before then restores it unsent, and a
        // crash after cannot bring it back.
        cleared = true
        outboxBefore = new Set(
          getStructuredAgentSessionOutbox(structuredTransport.sessionId).map(
            (entry) => entry.clientMessageId
          )
        )
        clearNativeChatDraftForHeldSend(draftKey, clearComposer)
      })
        .then(
          ({ accepted, error }) => {
            structuredTransport.onError(error)
            if (!accepted) {
              putBack()
              return
            }
            // The held send goes once the host holds the message for good (the agent accepted it,
            // or a card), or it is withdrawn back into the box or dropped; a refusal's new id
            // renames it.
            if (cleared) {
              const entry = getStructuredAgentSessionOutbox(structuredTransport.sessionId).find(
                (candidate) => !outboxBefore.has(candidate.clientMessageId)
              )
              holdNativeChatDraftSend(draftKey, sent, entry?.clientMessageId)
              if (entry) {
                let heldAs = entry.clientMessageId
                void whenStructuredAgentSessionHostHasMessages(
                  structuredTransport.sessionId,
                  [entry],
                  (from, to) => {
                    renameNativeChatHeldSend(draftKey, from, to)
                    heldAs = to
                  }
                ).then(() => releaseNativeChatHeldSend(draftKey, heldAs))
              }
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
            if (
              cleared ||
              (hostCommand &&
                (composition.current.draft !== submitted.draft ||
                  composition.current.imageAttachments !== submitted.imageAttachments))
            ) {
              return
            }
            clearComposer()
          },
          (error: unknown) => {
            putBack()
            throw error
          }
        )
        .catch((error) =>
          structuredTransport.onError(error instanceof Error ? error.message : String(error))
        )
    },
    [
      agent,
      clearImageAttachments,
      clearSkillOrigin,
      draftKey,
      imageAttachments,
      setCaret,
      setDraft,
      setHistory,
      structuredTransport
    ]
  )
}
