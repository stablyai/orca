import type {
  AgentSessionQueuedMessageEditHoldParams,
  AgentSessionQueuedMessageEditHoldResult
} from './agent-session-wire'

/** A quarter of the host's two-minute lease. */
export const QUEUED_EDIT_LEASE_RENEW_MS = 30_000

export type QueuedEditLease = {
  acquired: Promise<AgentSessionQueuedMessageEditHoldResult>
  end: () => void
}

export function startQueuedEditLease(args: {
  sessionId: string
  messageId: string
  editId: string
  expectedBodyFingerprint: string
  request: (
    params: AgentSessionQueuedMessageEditHoldParams
  ) => Promise<AgentSessionQueuedMessageEditHoldResult>
}): QueuedEditLease {
  const { sessionId, messageId, editId, expectedBodyFingerprint, request } = args
  let ended = false
  let held = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const call = (action: AgentSessionQueuedMessageEditHoldParams['action']) =>
    request(
      action === 'acquire'
        ? { sessionId, messageId, editId, action, expectedBodyFingerprint }
        : { sessionId, messageId, editId, action }
    )
  const acquired = call('acquire')
  // Release follows a pending acquisition or renewal.
  let chain: Promise<unknown> = acquired.catch(() => undefined)
  const keepAlive = (answer: AgentSessionQueuedMessageEditHoldResult | undefined): void => {
    if (ended) {
      return
    }
    if (answer?.status === 'expired') {
      held = false
      send('acquire')
    } else if (answer === undefined || answer.status === 'held') {
      held ||= answer?.status === 'held'
      timer = setTimeout(() => send(held ? 'renew' : 'acquire'), QUEUED_EDIT_LEASE_RENEW_MS)
    }
  }
  const failed = (error: unknown): void => {
    console.warn('[queued-message-edit] edit hold request failed', error)
    keepAlive(undefined)
  }
  const send = (action: 'acquire' | 'renew'): void => {
    chain = chain.then(() => (ended ? undefined : call(action))).then(keepAlive, failed)
  }
  void acquired.then(keepAlive, failed)
  return {
    acquired,
    end: () => {
      if (ended) {
        return
      }
      ended = true
      clearTimeout(timer)
      chain = chain
        .then(() => call('release'))
        .catch((error: unknown) => {
          console.warn('[queued-message-edit] edit hold release failed', error)
        })
    }
  }
}
