import type { AgentSessionWireRefusal } from './agent-session-wire'
import { agentSessionRefusalError } from './agent-session-wire-refusals'
import { waitForPromiseWithSignal } from './abort-signal-reason'

/**
 * The whole switch: stop (≤15 s), the at-rest prepare (transcript import, or the terminal spawn,
 * which the daemon request bounds at 30 s), and one layout replace. The client allows one IPC
 * round trip more.
 */
export const AGENT_SESSION_SWITCH_HOST_MS = 90_000
export const AGENT_SESSION_SWITCH_CLIENT_MS = 105_000

export type AgentSessionSwitchResult =
  | {
      status: 'completed'
      sessionId: string
      terminal?: string
      sourceRetained?: boolean
    }
  | {
      status: 'refused' | 'uncertain'
      refusal: AgentSessionWireRefusal
      sessionId: string
      failureItemId?: string
    }

/** Expiry revokes new effects; already dispatched owners still reconcile their real outcome. */
export function agentSessionSwitchDeadline(
  now = () => performance.now(),
  budget = AGENT_SESSION_SWITCH_HOST_MS
) {
  let expiresAt = now() + budget
  let dispatched = false
  let delegated = false
  const controller = new AbortController()
  let timer = setTimeout(() => controller.abort(expired()), budget)
  function expired() {
    return agentSessionRefusalError('agent_session_operation_expired', {
      reason: 'operationExpired'
    })
  }
  return {
    signal: controller.signal,
    delegateSend: () => {
      if (controller.signal.aborted) {
        throw expired()
      }
      const dispatchExpiresAt = expiresAt
      if (!dispatched && !delegated) {
        if (now() >= expiresAt) {
          throw expired()
        }
        delegated = true
        clearTimeout(timer)
        // Main now owns unsent expiry; allow its actual-send receipt to cross IPC.
        timer = setTimeout(() => controller.abort(expired()), expiresAt - now() + budget)
      }
      return {
        expiresAt: dispatchExpiresAt,
        responseTimeoutMs: budget,
        ...(dispatched ? { responseExpiresAt: expiresAt } : {})
      }
    },
    beforeSend: (sentAt = now()) => {
      if (controller.signal.aborted || (!dispatched && sentAt >= expiresAt)) {
        throw expired()
      }
      if (dispatched) {
        return
      }
      dispatched = true
      expiresAt = sentAt + budget
      clearTimeout(timer)
      timer = setTimeout(() => controller.abort(expired()), Math.max(0, expiresAt - now()))
      if (now() >= expiresAt) {
        controller.abort(expired())
      }
    },
    revoke: (reason: unknown = expired()) => controller.abort(reason),
    remaining: () => Math.max(0, expiresAt - now()),
    check: () => {
      if (controller.signal.aborted) {
        throw controller.signal.reason
      }
      if (now() >= expiresAt) {
        controller.abort(expired())
        throw controller.signal.reason
      }
    },
    wait: <T>(promise: Promise<T>) => waitForPromiseWithSignal(promise, controller.signal),
    dispose: () => clearTimeout(timer)
  }
}
export type AgentSessionSwitchDeadline = ReturnType<typeof agentSessionSwitchDeadline>
