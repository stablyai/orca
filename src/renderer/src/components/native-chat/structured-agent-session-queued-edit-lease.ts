// One inline editor's lease on the execution host: acquired when the editor opens, renewed while
// it stays open, released when it closes. The host expires it on its own, so a renewal or release
// that fails is only logged; nothing here ever blocks typing, Save or Cancel.

import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import type {
  AgentSessionQueuedMessageEditHoldParams,
  AgentSessionQueuedMessageEditHoldResult
} from '../../../../shared/agent-session-wire'

/** A quarter of the host's two-minute lease, so one lost renewal never lets it lapse. */
export const QUEUED_EDIT_LEASE_RENEW_MS = 30_000

export type QueuedEditLease = {
  /** The host's first answer; a transport failure rejects it. */
  acquired: Promise<AgentSessionQueuedMessageEditHoldResult>
  /** Stops renewing and releases, after any request still on its way. */
  end: () => void
}

function logLeaseFailure(error: unknown): void {
  console.warn('[queued-message-edit] edit hold request failed', error)
}

export function startQueuedEditLease(input: {
  target: RuntimeClientTarget
  sessionId: string
  messageId: string
  editId: string
  expectedBodyFingerprint: string
}): QueuedEditLease {
  const { target, sessionId, messageId, editId, expectedBodyFingerprint } = input
  let ended = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const call = (
    action: AgentSessionQueuedMessageEditHoldParams['action']
  ): Promise<AgentSessionQueuedMessageEditHoldResult> =>
    callStructuredAgentSession<AgentSessionQueuedMessageEditHoldResult>(
      target,
      'agentSession.queuedMessageEditHold',
      {
        sessionId,
        messageId,
        editId,
        action,
        ...(action === 'acquire' ? { expectedBodyFingerprint } : {})
      }
    )
  const acquired = call('acquire')
  // Requests go one at a time, so a release never overtakes the acquire it releases.
  let chain: Promise<unknown> = acquired.catch(() => undefined)
  let held = false
  const send = (action: 'acquire' | 'renew'): void => {
    chain = chain
      .then(() => (ended ? undefined : call(action)))
      .then(keepAlive, (error: unknown) => {
        logLeaseFailure(error)
        keepAlive(undefined)
      })
  }
  const keepAlive = (answer: AgentSessionQueuedMessageEditHoldResult | undefined): void => {
    if (ended || !answer) {
      // A failed request is tried again on the next beat; the host's deadline covers the gap.
      if (!ended) {
        timer = setTimeout(() => send(held ? 'renew' : 'acquire'), QUEUED_EDIT_LEASE_RENEW_MS)
      }
      return
    }
    if (answer.status === 'expired') {
      // A lapsed lease (a host restart, a reopened chat) is taken again at once for the same text.
      held = false
      send('acquire')
    } else if (answer.status === 'held') {
      held = true
      timer = setTimeout(() => send('renew'), QUEUED_EDIT_LEASE_RENEW_MS)
    }
    // `changed`, `gone` and `not-editable` are final: the card moved on, nothing is left to hold.
  }
  void acquired.then(keepAlive, (error: unknown) => {
    logLeaseFailure(error)
    keepAlive(undefined)
  })
  return {
    acquired,
    end: () => {
      if (ended) {
        return
      }
      ended = true
      clearTimeout(timer)
      chain = chain.then(() => call('release')).catch(logLeaseFailure)
    }
  }
}
