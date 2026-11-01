import type { AgentSessionMutationEnvelope } from './agent-session-wire'
import { structuredAgentSessionPayloadFingerprint } from './structured-agent-session-mutation'

type Submission = {
  envelope: AgentSessionMutationEnvelope & { expectedRuntimeFence: number }
  unknown: boolean
}

/** Only transport identity is retained; the editable draft remains the full-content source. */
export function createAgentSessionFormSubmissions() {
  const latest = new Map<string, Submission>()
  return {
    capture(args: {
      method: string
      fingerprintMethod: string
      sessionId: string
      fields: Record<string, unknown>
      fence: number
      operationId: () => string
      liveItemIds?: ReadonlySet<string>
    }): Submission | undefined {
      if (
        args.method !== 'agentSession.respondToApproval' ||
        args.fields.content === undefined ||
        typeof args.fields.itemId !== 'string'
      ) {
        return undefined
      }
      if (args.liveItemIds) {
        for (const id of latest.keys()) {
          if (!args.liveItemIds.has(id)) {
            latest.delete(id)
          }
        }
      }
      const payloadFingerprint = structuredAgentSessionPayloadFingerprint({
        method: args.fingerprintMethod,
        sessionId: args.sessionId,
        fields: args.fields
      })
      const previous = latest.get(args.fields.itemId)
      if (previous?.envelope.payloadFingerprint === payloadFingerprint) {
        return previous
      }
      const submission = {
        envelope: {
          sessionId: args.sessionId,
          clientOperationId: args.operationId(),
          expectedRuntimeFence: args.fence,
          payloadFingerprint
        },
        unknown: false
      }
      latest.set(args.fields.itemId, submission)
      return submission
    },
    settle(itemId: unknown, submission: Submission | undefined, unknown: boolean): void {
      if (!submission) {
        return
      }
      submission.unknown = unknown
      if (!unknown && typeof itemId === 'string' && latest.get(itemId) === submission) {
        latest.delete(itemId)
      }
    }
  }
}
