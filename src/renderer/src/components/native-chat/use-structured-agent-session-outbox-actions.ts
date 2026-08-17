import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import {
  createStructuredAgentSessionOutboxEntry,
  structuredAgentSessionSendBody,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import { writeOutbox } from './structured-agent-session-outbox-storage'

export function useStructuredAgentSessionOutboxActions(args: {
  sessionId: string
  submissions: readonly AgentJournalSubmission[]
  outboxRef: MutableRefObject<StructuredAgentSessionOutboxEntry[]>
  blockedIdRef: MutableRefObject<string | null>
  setOutbox: Dispatch<SetStateAction<StructuredAgentSessionOutboxEntry[]>>
  setError: Dispatch<SetStateAction<string | null>>
  createOperationId: () => string
}) {
  const {
    blockedIdRef,
    createOperationId,
    outboxRef,
    sessionId,
    setError,
    setOutbox,
    submissions
  } = args

  const send = useCallback(
    (text: string, attachments: readonly { path: string; previewUri: string }[] = []): boolean => {
      if (!text.trim() && attachments.length === 0) {
        return false
      }
      const entry = createStructuredAgentSessionOutboxEntry({
        clientMessageId: createOperationId(),
        sessionId,
        text,
        attachments,
        queuedAt: Date.now()
      })
      const next = [...outboxRef.current, entry]
      if (!writeOutbox(sessionId, next)) {
        setError('Message could not be saved to the outbox')
        return false
      }
      outboxRef.current = next
      setOutbox(next)
      setError(null)
      return true
    },
    [createOperationId, outboxRef, sessionId, setError, setOutbox]
  )

  const edit = useCallback(
    (
      clientMessageId: string,
      text: string,
      attachments: readonly { path: string; previewUri: string }[] = []
    ): boolean => {
      const current = outboxRef.current.find((entry) => entry.clientMessageId === clientMessageId)
      if (!current || current.state === 'dispatching' || current.state === 'unconfirmed') {
        return false
      }
      const next = outboxRef.current.map((entry) =>
        entry.clientMessageId === clientMessageId
          ? {
              ...entry,
              body: structuredAgentSessionSendBody(text, attachments),
              previewUris: attachments.map((attachment) => attachment.previewUri),
              intent: undefined
            }
          : entry
      )
      if (!writeOutbox(sessionId, next)) {
        setError('Message could not be saved to the outbox')
        return false
      }
      outboxRef.current = next
      setOutbox(next)
      setError(null)
      return true
    },
    [outboxRef, sessionId, setError, setOutbox]
  )

  const remove = useCallback(
    (clientMessageId: string): boolean => {
      const current = outboxRef.current.find((entry) => entry.clientMessageId === clientMessageId)
      if (!current || current.state === 'dispatching' || current.state === 'unconfirmed') {
        return false
      }
      const next = outboxRef.current.filter((entry) => entry.clientMessageId !== clientMessageId)
      if (!writeOutbox(sessionId, next)) {
        setError('Message could not be saved to the outbox')
        return false
      }
      blockedIdRef.current = blockedIdRef.current === clientMessageId ? null : blockedIdRef.current
      outboxRef.current = next
      setOutbox(next)
      setError(null)
      return true
    },
    [blockedIdRef, outboxRef, sessionId, setError, setOutbox]
  )

  const reorder = useCallback(
    (clientMessageIds: readonly string[]): boolean => {
      const current = outboxRef.current
      if (
        clientMessageIds.length !== current.length ||
        new Set(clientMessageIds).size !== current.length ||
        current.some((entry) => entry.state === 'dispatching')
      ) {
        return false
      }
      const byId = new Map(current.map((entry) => [entry.clientMessageId, entry]))
      const next = clientMessageIds.map((id) => byId.get(id)).filter((entry) => entry !== undefined)
      if (next.length !== current.length || !writeOutbox(sessionId, next)) {
        setError('Message could not be saved to the outbox')
        return false
      }
      outboxRef.current = next
      setOutbox(next)
      return true
    },
    [outboxRef, sessionId, setError, setOutbox]
  )

  const steer = useCallback(
    (clientMessageId: string): boolean => {
      const next = outboxRef.current.map((entry) =>
        entry.clientMessageId === clientMessageId && entry.state === 'queued'
          ? { ...entry, intent: 'steer' as const }
          : entry
      )
      if (
        next.every((entry, index) => entry === outboxRef.current[index]) ||
        !writeOutbox(sessionId, next)
      ) {
        return false
      }
      blockedIdRef.current = null
      outboxRef.current = next
      setOutbox(next)
      setError(null)
      return true
    },
    [blockedIdRef, outboxRef, sessionId, setError, setOutbox]
  )

  const retry = (clientMessageId: string): void => {
    blockedIdRef.current = null
    setError(null)
    const submission = submissions.find(
      (candidate) => candidate.clientMessageId === clientMessageId
    )
    const current = outboxRef.current.find((entry) => entry.clientMessageId === clientMessageId)
    // A provider-history reconciliation can settle an earlier unknown as
    // rejected before the user presses Retry. Reusing that operation id only
    // replays the settled rejection forever, so rotate the id for a safe resend.
    if (current && submission?.dispatchState === 'rejected') {
      const rotated = outboxRef.current.map((entry) =>
        entry.clientMessageId === clientMessageId
          ? {
              ...entry,
              clientMessageId: createOperationId(),
              state: 'queued' as const,
              retryAfterUnknownSubmittedAt: null
            }
          : entry
      )
      if (!writeOutbox(sessionId, rotated)) {
        setError('Message could not be saved to the outbox')
        return
      }
      outboxRef.current = rotated
      setOutbox(rotated)
      return
    }
    const retryAfterUnknownSubmittedAt =
      submission?.dispatchState === 'unknown'
        ? submission.submittedAt
        : current?.state === 'unconfirmed'
          ? -1
          : null
    const next = outboxRef.current.map((entry) =>
      entry.clientMessageId === clientMessageId
        ? {
            ...entry,
            state: 'queued' as const,
            retryAfterUnknownSubmittedAt
          }
        : entry
    )
    if (!writeOutbox(sessionId, next)) {
      setError('Message could not be saved to the outbox')
      return
    }
    outboxRef.current = next
    setOutbox(next)
  }

  return { send, edit, remove, reorder, steer, retry }
}
