import { AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY } from './agent-session-current-requests-capability'
import type { AgentJournalRenderItem } from './agent-session-journal-types'
import { isAdmissibleAgentJournalRenderItem } from './agent-session-journal-schemas'
import type {
  AgentSessionCurrentRequestsMarker,
  AgentSessionCurrentRequestsPiece,
  AgentSessionCurrentRequestsRead
} from './agent-session-current-requests-wire'

/** One in-flight piece per owner, including replacement subscriptions awaiting an old reply. */
export function createAgentSessionCurrentRequestsReader(args: {
  read: (request: AgentSessionCurrentRequestsRead) => Promise<AgentSessionCurrentRequestsPiece>
  complete: (marker: AgentSessionCurrentRequestsMarker, items: AgentJournalRenderItem[]) => void
  replaceMarker: (marker: AgentSessionCurrentRequestsMarker) => void
  error: (error: unknown, marker: AgentSessionCurrentRequestsMarker) => void
}) {
  let generation = 0
  let desired: AgentSessionCurrentRequestsMarker | undefined
  let running = false
  let attempted: string | undefined
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
    try {
      while (current()) {
        const piece = await args.read({
          sessionId: marker.sessionId,
          version: marker.version,
          cursor
        })
        if (!current()) {
          return
        }
        if (piece.restart) {
          if (
            piece.marker.sessionId !== marker.sessionId ||
            piece.marker.version === marker.version ||
            piece.marker.contract !== AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY
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
          piece.marker.version !== marker.version ||
          piece.marker.owner !== marker.owner ||
          piece.marker.epoch !== marker.epoch ||
          piece.marker.sessionId !== marker.sessionId
        ) {
          throw new Error('Current-request version changed')
        }
        chunks.push(piece.json)
        if (piece.nextCursor === null) {
          const value: unknown = JSON.parse(chunks.join(''))
          if (
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
          args.complete(marker, value)
          return
        }
        if (!Number.isSafeInteger(piece.nextCursor) || piece.nextCursor <= cursor) {
          throw new Error('Invalid current-request cursor')
        }
        cursor = piece.nextCursor
      }
    } catch (error) {
      if (current()) {
        args.error(error, marker)
      }
    } finally {
      running = false
      void pump()
    }
  }
  return {
    observe(marker: AgentSessionCurrentRequestsMarker | undefined): void {
      if (marker && marker.contract !== AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY) {
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
      void pump()
    },
    invalidate(): void {
      generation += 1
      desired = undefined
      attempted = undefined
    }
  }
}
