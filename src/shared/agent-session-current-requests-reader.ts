import { z } from 'zod'
import { messageQuestionOccurrenceSchema } from './message-question-occurrence'
import { waitForPromiseWithSignal } from './abort-signal-reason'
import type { CurrentRequestsPayload } from './agent-session-current-requests-wire'
import {
  AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY,
  AGENT_SESSION_CURRENT_REQUESTS_V2
} from './agent-session-current-requests-capability'
import type { AgentJournalRenderItem } from './agent-session-journal-types'
import { isAdmissibleAgentJournalRenderItem } from './agent-session-journal-schemas'
import { readAgentSessionErrorRefusal } from './agent-session-write-failure'
import { isFinalAgentSessionReadRefusal } from './structured-agent-session-read-refusal'
import { createReconnectScheduler } from './structured-agent-session-reconnect'
import type {
  AgentSessionCurrentRequestsMarker,
  AgentSessionCurrentRequestsPiece,
  AgentSessionCurrentRequestsRead
} from './agent-session-current-requests-wire'

const payloadSchema = z.object({
  blocking: z.array(z.custom<AgentJournalRenderItem>(isAdmissibleAgentJournalRenderItem)),
  asyncQuestions: z.array(messageQuestionOccurrenceSchema),
  context: z.object({ sessionId: z.string(), boundary: z.string() })
})
function supported(contract: string): boolean {
  return (
    contract === AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY ||
    contract === AGENT_SESSION_CURRENT_REQUESTS_V2
  )
}

/** One in-flight piece per owner, including replacement subscriptions awaiting an old reply. */
export function createAgentSessionCurrentRequestsReader(args: {
  read: (
    request: AgentSessionCurrentRequestsRead,
    signal: AbortSignal
  ) => Promise<AgentSessionCurrentRequestsPiece>
  complete: (
    marker: AgentSessionCurrentRequestsMarker,
    items: AgentJournalRenderItem[],
    payload?: CurrentRequestsPayload
  ) => void
  replaceMarker: (marker: AgentSessionCurrentRequestsMarker) => void
  /** Only failures that will not be retried are reported. */
  error: (error: unknown) => void
}) {
  let generation = 0
  let desired: AgentSessionCurrentRequestsMarker | undefined
  let running = false
  let attempted: string | undefined
  let failedVersion: string | undefined
  let activeRead: AbortController | undefined
  async function readPiece(
    request: AgentSessionCurrentRequestsRead
  ): Promise<AgentSessionCurrentRequestsPiece> {
    const controller = new AbortController()
    activeRead = controller
    const timeout = setTimeout(
      () => controller.abort(new Error('Current-request read timed out')),
      15_000
    )
    try {
      return await waitForPromiseWithSignal(
        args.read(request, controller.signal),
        controller.signal
      )
    } finally {
      clearTimeout(timeout)
      if (activeRead === controller) {
        activeRead = undefined
      }
    }
  }
  // A read that failed in transit re-reads the same version with the stream's reconnect backoff.
  const retry = createReconnectScheduler({
    shouldStop: () => desired === undefined || desired.version !== failedVersion,
    reconnect: () => {
      attempted = undefined
      void pump()
    }
  })
  async function pump(): Promise<void> {
    if (running || !desired || attempted === desired.version) {
      return
    }
    running = true
    const ownedGeneration = generation
    let marker = desired
    attempted = marker.version
    let cursor = 0
    const chunks: string[] = []
    const current = () => generation === ownedGeneration && desired?.version === marker.version
    let reading = false
    try {
      while (current()) {
        reading = true
        const piece = await readPiece({
          sessionId: marker.sessionId,
          version: marker.version,
          cursor
        })
        reading = false
        if (!current()) {
          return
        }
        if (piece.restart) {
          if (
            piece.marker.sessionId !== marker.sessionId ||
            piece.marker.version === marker.version ||
            piece.marker.contract !== marker.contract
          ) {
            throw new Error('Invalid request owner')
          }
          desired = marker = piece.marker
          attempted = marker.version
          args.replaceMarker(marker)
          chunks.length = 0
          cursor = 0
          continue
        }
        if (
          piece.marker.contract !== marker.contract ||
          piece.marker.version !== marker.version ||
          piece.marker.owner !== marker.owner ||
          piece.marker.epoch !== marker.epoch ||
          piece.marker.sessionId !== marker.sessionId
        ) {
          throw new Error('Current-request version changed')
        }
        chunks.push(piece.json)
        if (piece.nextCursor === null) {
          const decoded: unknown = JSON.parse(chunks.join(''))
          const payload =
            marker.contract === AGENT_SESSION_CURRENT_REQUESTS_V2
              ? payloadSchema.parse(decoded)
              : undefined
          const value: unknown = payload ? payload.blocking : decoded
          if (
            (payload && payload.context.sessionId !== marker.sessionId) ||
            !Array.isArray(value) ||
            !value.every(isAdmissibleAgentJournalRenderItem) ||
            !value.every(
              (item) =>
                (item.body.kind === 'approval' || item.body.kind === 'question') &&
                item.body.resolution.state === 'pending'
            )
          ) {
            throw new Error('Invalid current requests')
          }
          retry.reset()
          if (payload) {
            args.complete(marker, value, payload)
          } else {
            args.complete(marker, value)
          }
          return
        }
        if (!Number.isSafeInteger(piece.nextCursor) || piece.nextCursor <= cursor) {
          throw new Error('Invalid current-request cursor')
        }
        cursor = piece.nextCursor
      }
    } catch (error) {
      // Answers that break the contract fail the same way again; only transport and host failures retry.
      if (!current()) {
        return
      }
      if (reading && !isFinalAgentSessionReadRefusal(readAgentSessionErrorRefusal(error))) {
        failedVersion = marker.version
        retry.schedule()
      } else {
        args.error(error)
      }
    } finally {
      running = false
      void pump()
    }
  }
  return {
    observe(marker: AgentSessionCurrentRequestsMarker | undefined): void {
      if (marker && !supported(marker.contract)) {
        return
      }
      if (desired?.version === marker?.version) {
        return
      }
      if (
        marker &&
        desired?.publisher === marker.publisher &&
        marker.revision <= desired.revision
      ) {
        return
      }
      desired = marker
      activeRead?.abort()
      void pump()
    },
    invalidate(): void {
      generation += 1
      desired = undefined
      attempted = undefined
      activeRead?.abort()
      retry.dispose()
      retry.reset()
    }
  }
}
