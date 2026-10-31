import { structuredAgentSessionSettledSends } from '../../../../shared/structured-agent-session-send-settlement'
import { STRUCTURED_AGENT_SESSION_SUBMISSION_MISSING } from '../../../../shared/structured-agent-session-send-evidence'
import type { StructuredAgentSessionState } from '../../../../shared/structured-agent-session-reducer'
import type { StructuredAgentSessionReadOwner } from './structured-agent-session-read-owner-contract'

/** Transient work and consent holders belong to the existing read owner, independently of its view transport. */
export function createStructuredAgentSessionReadActivity(
  alive: () => boolean,
  readState: () => StructuredAgentSessionState
) {
  const operations = new Map<string, boolean>()
  let revision = 0
  let admission: {
    intent: string
    promise: Promise<void>
    current: () => boolean
    cancel: () => void
  } | null = null
  const settle = (id: string): void => {
    if (operations.delete(id)) {
      revision += 1
    }
  }
  const observe = (state: StructuredAgentSessionState): void => {
    if (operations.size) {
      const { cards, recorded } = structuredAgentSessionSettledSends(
        state.submissions.filter(
          (row) => row.reason !== STRUCTURED_AGENT_SESSION_SUBMISSION_MISSING
        ),
        state.queuedMessages?.map((card) => card.messageId) ?? []
      )
      for (const id of operations.keys()) {
        if (cards.has(id) || recorded.has(id)) {
          settle(id)
        }
      }
    }
  }
  const trackSend: StructuredAgentSessionReadOwner['trackSend'] = (id) => {
    if (alive()) {
      operations.set(id, false)
      observe(readState())
    }
    return {
      issue: () => {
        if (alive() && operations.has(id)) {
          operations.set(id, true)
          revision += 1
        }
      },
      settle: (uncertain) => {
        if (!uncertain || operations.get(id) === false) {
          settle(id)
        }
      }
    }
  }
  const admit: StructuredAgentSessionReadOwner['admit'] = (intent, valid, effect) => {
    if (!alive()) {
      return Promise.resolve()
    }
    if (admission?.intent === intent && admission.current()) {
      return admission.promise
    }
    const previous = admission
    const { promise, resolve } = Promise.withResolvers<void>()
    const abort = new AbortController()
    const capturedRevision = revision
    const active = {
      intent,
      promise,
      current: (): boolean => alive() && admission === active && valid(),
      busy: (): boolean => revision !== capturedRevision || [...operations.values()].some(Boolean),
      signal: abort.signal,
      cancel: () => {
        abort.abort()
        resolve()
        if (admission === active) {
          admission = null
        }
      }
    }
    admission = active
    previous?.cancel()
    try {
      void Promise.resolve(effect(active)).then(active.cancel, active.cancel)
    } catch {
      active.cancel()
    }
    return promise
  }
  return {
    observe,
    trackSend,
    admit,
    settle,
    retained: () => operations.size > 0 || admission !== null,
    dispose: () => {
      operations.clear()
      admission?.cancel()
    }
  }
}
